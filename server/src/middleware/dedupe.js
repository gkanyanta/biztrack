// Rejects an exact repeat of the same write (same user + route + body) that arrives within
// a short window. Catches double-clicks and duplicate form submits — e.g. a slow network
// response tempting a second click before the UI has a chance to disable the button.
const recentSubmits = new Map();
const WINDOW_MS = 5000;

function preventDuplicateSubmit(req, res, next) {
  const key = `${req.user.id}:${req.method}:${req.originalUrl}:${JSON.stringify(req.body)}`;
  const now = Date.now();
  const last = recentSubmits.get(key);
  if (last && now - last < WINDOW_MS) {
    return res.status(409).json({ error: 'This looks like a duplicate submission. Please wait a moment and check before retrying.' });
  }
  recentSubmits.set(key, now);
  if (recentSubmits.size > 1000) {
    for (const [k, t] of recentSubmits) { if (now - t > WINDOW_MS) recentSubmits.delete(k); }
  }
  next();
}

module.exports = { preventDuplicateSubmit };
