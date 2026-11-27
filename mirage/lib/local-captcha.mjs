import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_ANSWER_LENGTH = 80;
const digest = (text) => createHash('sha256').update(text).digest();
const scopeKey = ({ owner, kind, formId, stepId }) =>
  owner && kind && formId ? JSON.stringify([owner, kind, formId, stepId ?? null]) : null;

/** In-process challenge state for an explicitly enabled local fixture. */
export function createLocalCaptcha({ challenge, now = Date.now, lifetimeMs = 120_000, limit = 1_000 }) {
  const issued = new Map();
  return {
    clear: () => issued.clear(),
    issue(scope) {
      const key = scopeKey(scope);
      if (!key) return null;
      let fixture;
      try {
        fixture = challenge({ surface: scope.kind });
      } catch {
        return null;
      }
      const { prompt, answer } = fixture ?? {};
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 500) return null;
      if (typeof answer !== 'string' || !answer.trim() || answer.length > MAX_ANSWER_LENGTH) return null;
      const expires = now() + lifetimeMs;
      const id = randomUUID();
      if (issued.size >= limit) issued.delete(issued.keys().next().value);
      issued.set(id, { key, expires, answer: digest(answer.trim()) });
      return { id, prompt };
    },
    redeem(scope, proof) {
      const { challengeId, answer } = proof ?? {};
      if (
        typeof challengeId !== 'string' ||
        challengeId.length !== 36 ||
        typeof answer !== 'string' ||
        answer.length > MAX_ANSWER_LENGTH
      )
        return false;
      const record = issued.get(challengeId);
      if (record?.key !== scopeKey(scope)) return false;
      issued.delete(challengeId);
      return record.expires > now() && timingSafeEqual(record.answer, digest(answer.trim()));
    },
  };
}
