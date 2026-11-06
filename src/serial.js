/** Runs async tasks one at a time, in call order; a failed task does not block the next. */
export function createSerializer() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}
