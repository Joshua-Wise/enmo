import type { Migration } from './index';

/**
 * Users and their sessions (docs/adr/0010). A username is unique ignoring case: the column's
 * collation compares `Admin` and `admin` as one. The password is a scrypt hash with its own salt
 * and parameters (passwords.ts); `must_change_password` is set only on the `admin` a fresh install
 * starts with, until it is changed. A session row holds the SHA-256 of the cookie's random id,
 * never the id, so a database read hands out no live session; it goes with its user. Nothing is
 * inserted here: the first start with no users creates `admin` (users.ts). IF NOT EXISTS, so a run
 * that died before being recorded can repeat.
 */
export const usersSchema: Migration = {
  id: '0021-users',
  async up(conn) {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
        username             VARCHAR(64)  NOT NULL COLLATE utf8mb4_0900_ai_ci,
        password_hash        VARCHAR(255) NOT NULL,
        role                 ENUM('admin', 'viewer') NOT NULL,
        disabled             TINYINT(1)   NOT NULL DEFAULT 0,
        must_change_password TINYINT(1)   NOT NULL DEFAULT 0,
        created_at           DATETIME(3)  NOT NULL,
        last_sign_in_at      DATETIME(3)  NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id           CHAR(64)     NOT NULL,
        user_id      INT UNSIGNED NOT NULL,
        created_at   DATETIME(3)  NOT NULL,
        last_seen_at DATETIME(3)  NOT NULL,
        PRIMARY KEY (id),
        KEY ix_sessions_user (user_id),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  },
};
