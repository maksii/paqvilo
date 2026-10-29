// Bounded external sort for immutable record-key indexes.
import fs from 'node:fs';
import path from 'node:path';
import { temporaryRecordName } from './record-file-lease.mjs';

export const compareKeyPair = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : Math.sign(a[1] - b[1]));

function* readRun(file) {
  const fd = fs.openSync(file, 'r'),
    buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = Buffer.alloc(0);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      const bytes = pending.length ? Buffer.concat([pending, buffer.subarray(0, count)]) : buffer.subarray(0, count);
      let start = 0,
        end;
      while ((end = bytes.indexOf(10, start)) >= 0) {
        yield JSON.parse(bytes.toString('utf8', start, end));
        start = end + 1;
      }
      pending = Buffer.from(bytes.subarray(start));
    }
    if (pending.length) throw Error('Incomplete temporary key run');
  } finally {
    fs.closeSync(fd);
  }
}

function* mergeRuns(files) {
  const readers = files.map((file) => readRun(file)),
    heap = [];
  const less = (a, b) => compareKeyPair(a.value, b.value) < 0;
  const push = (item) => {
    let index = heap.length;
    heap.push(item);
    while (index) {
      const parent = (index - 1) >>> 1;
      if (!less(item, heap[parent])) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = item;
  };
  const pop = () => {
    const first = heap[0],
      last = heap.pop();
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && less(heap[child + 1], heap[child])) child++;
        if (!less(heap[child], last)) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = last;
    }
    return first;
  };
  try {
    readers.forEach((reader, index) => {
      const item = reader.next();
      if (!item.done) push({ value: item.value, index });
    });
    while (heap.length) {
      const item = pop();
      yield item.value;
      const next = readers[item.index].next();
      if (!next.done) push({ value: next.value, index: item.index });
    }
  } finally {
    for (const reader of readers) reader.return();
  }
}

export class KeySorter {
  constructor(directory, { entries = 100000, bytes = 16 * 1024 * 1024, fanIn = 64 } = {}) {
    if (
      !Number.isInteger(entries) ||
      entries < 1 ||
      !Number.isInteger(bytes) ||
      bytes < 1 ||
      !Number.isInteger(fanIn) ||
      fanIn < 2 ||
      fanIn > 64
    )
      throw TypeError('Invalid key sort budgets');
    this.directory = directory;
    this.limit = entries;
    this.byteLimit = bytes;
    this.fanIn = fanIn;
    this.pending = [];
    this.bytes = 0;
    this.files = new Set();
    this.runs = [];
    this.finished = false;
    this.peakEntries = 0;
    this.peakBytes = 0;
  }
  add(pair) {
    if (this.finished) throw Error('Key sorter already consumed');
    const size = Buffer.byteLength(pair[0]) * 2 + 96;
    if (this.pending.length && (this.pending.length >= this.limit || this.bytes + size > this.byteLimit)) this.flush();
    this.pending.push(pair);
    this.bytes += size;
    this.peakEntries = Math.max(this.peakEntries, this.pending.length);
    this.peakBytes = Math.max(this.peakBytes, this.bytes);
  }
  write(iterable) {
    const file = path.join(this.directory, temporaryRecordName('sort'));
    const fd = fs.openSync(file, 'wx', 0o600);
    this.files.add(file);
    let pending = '',
      size = 0;
    const flush = () => {
      if (!pending) return;
      const bytes = Buffer.from(pending);
      let done = 0;
      while (done < bytes.length) {
        const count = fs.writeSync(fd, bytes, done);
        if (!count) throw Error('Incomplete key-run write');
        done += count;
      }
      pending = '';
      size = 0;
    };
    try {
      for (const pair of iterable) {
        const line = JSON.stringify(pair) + '\n';
        pending += line;
        size += Buffer.byteLength(line);
        if (size >= 256 * 1024) flush();
      }
      flush();
      return file;
    } finally {
      fs.closeSync(fd);
    }
  }
  flush() {
    if (!this.pending.length) return;
    this.pending.sort(compareKeyPair);
    this.runs.push(this.write(this.pending));
    this.pending = [];
    this.bytes = 0;
  }
  *sorted() {
    if (this.finished) throw Error('Key sorter already consumed');
    this.finished = true;
    try {
      if (!this.runs.length) {
        this.pending.sort(compareKeyPair);
        yield* this.pending;
        return;
      }
      this.flush();
      let runs = this.runs;
      while (runs.length > this.fanIn) {
        const next = [];
        for (let i = 0; i < runs.length; i += this.fanIn) {
          const group = runs.slice(i, i + this.fanIn);
          next.push(this.write(mergeRuns(group)));
          for (const file of group) {
            fs.unlinkSync(file);
            this.files.delete(file);
          }
        }
        runs = next;
      }
      yield* mergeRuns(runs);
    } finally {
      this.close();
    }
  }
  close() {
    this.pending = [];
    this.bytes = 0;
    let error;
    for (const file of this.files) {
      try {
        fs.unlinkSync(file);
        this.files.delete(file);
      } catch (failure) {
        error ??= failure;
      }
    }
    if (error) throw error;
  }
}
