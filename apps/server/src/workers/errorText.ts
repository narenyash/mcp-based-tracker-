/** Message for a caught value of any type: anything can be thrown, and callers must still clean up. */
export function errorText(err: unknown, max = 2000): string {
  let text: string;
  if (err instanceof Error) text = err.message || err.name;
  else if (typeof err === 'string') text = err;
  else {
    try {
      text = JSON.stringify(err) ?? String(err);
    } catch {
      text = String(err);
    }
  }
  return text.slice(0, max);
}
