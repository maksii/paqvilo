import fs from 'node:fs/promises';

/** Register shutdown only for the runtime and discovery path created by this command. */
export function registerRuntimeShutdown({
  close,
  discovery,
  owner = process,
  input = owner.stdin,
  exit = (code) => owner.exit(code),
}) {
  let stopping;
  const dispose = () => {
    owner.removeListener('SIGINT', requested);
    owner.removeListener('SIGTERM', requested);
    input?.removeListener('data', data);
  };
  const stop = () => {
    if (!stopping) {
      dispose();
      stopping = Promise.resolve().then(async () => {
        let closeError;
        try {
          await close();
        } catch (error) {
          closeError = error;
        }
        try {
          await fs.rm(discovery, { force: true });
        } catch (cleanupError) {
          if (closeError)
            throw new AggregateError([closeError, cleanupError], 'Runtime close and discovery cleanup failed.', {
              cause: cleanupError,
            });
          throw cleanupError;
        }
        if (closeError) throw closeError;
      });
    }
    return stopping;
  };
  const requested = () => {
    stop().then(
      () => exit(0),
      (error) => {
        owner.stderr?.write(`${error.message}\n`);
        exit(1);
      },
    );
  };
  const data = (chunk) => {
    if (String(chunk).trim() === 'stop') requested();
  };
  owner.once('SIGINT', requested);
  owner.once('SIGTERM', requested);
  input?.on('data', data);
  // Detached `mirage start` uses ignored stdin, which ends immediately. Only an
  // explicit stop command or process signal owns shutdown; EOF is not a stop.
  return { stop, dispose };
}
