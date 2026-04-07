const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'wokeavr-admin-secret-change-me';

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const token = authHeader.split(' ')[1];
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
