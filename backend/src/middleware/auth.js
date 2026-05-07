const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'wokeavr-admin-secret-change-me' || process.env.JWT_SECRET === 'change-me') {
  throw new Error('JWT_SECRET must be set to a strong unique value (not default/placeholder)');
}
const JWT_SECRET = process.env.JWT_SECRET;

function requireAdmin(req, res, next) {
  // Prefer Authorization header. Fall back to ?token= query param for browser
  // contexts that can't set headers (img tags, <a href> direct opens) — used
  // by /api/screenshots/* and /api/uploads/*. Query-param tokens leak into
  // access logs; only acceptable here because we control the audience (admin).
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query && typeof req.query.token === 'string') {
    token = req.query.token;
  }
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function signToken(adminId, username) {
  return jwt.sign({ id: adminId, username }, JWT_SECRET, { expiresIn: '7d' });
}

module.exports = { requireAdmin, signToken, JWT_SECRET };
