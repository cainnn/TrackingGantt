-- Treat usernames as case-insensitive identifiers for login and uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
  ON users (LOWER(username));
