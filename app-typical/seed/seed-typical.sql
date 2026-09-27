-- cwm-bench typical dataset. Deterministic SQL. No RAND(), NOW(), or UUID().
-- Row counts:
--   users:        1000
--   tags:           50
--   articles:    10000
--   article_tags: 30000   (3 distinct tags per article)
--   comments:    50000   (5 per article)
--   follows:     10000   (10 per user, never self)
-- Timestamps are 2026-01-01 00:00:00 plus an id offset.
-- Re-running is idempotent: tables are replaced.
-- Sequences come from a 0-9 digit table cross-join, not a recursive CTE.

CREATE DATABASE IF NOT EXISTS cwmbench CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE cwmbench;

DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS article_tags;
DROP TABLE IF EXISTS follows;
DROP TABLE IF EXISTS articles;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS digits;

-- A real table, not TEMPORARY: MySQL cannot reopen a temporary table when
-- the same digit table is cross-joined to itself (error 1137).
CREATE TABLE digits (
  d TINYINT NOT NULL PRIMARY KEY
) ENGINE=InnoDB;
INSERT INTO digits (d) VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9);

CREATE TABLE users (
  id INT UNSIGNED NOT NULL PRIMARY KEY,
  username VARCHAR(32) NOT NULL,
  email VARCHAR(64) NOT NULL,
  bio VARCHAR(100) NOT NULL,
  image VARCHAR(128) NOT NULL,
  password_hash CHAR(60) NOT NULL,
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE tags (
  id SMALLINT UNSIGNED NOT NULL PRIMARY KEY,
  name VARCHAR(16) NOT NULL,
  UNIQUE KEY uq_tags_name (name)
) ENGINE=InnoDB;

CREATE TABLE articles (
  id INT UNSIGNED NOT NULL PRIMARY KEY,
  slug VARCHAR(32) NOT NULL,
  title VARCHAR(60) NOT NULL,
  description VARCHAR(200) NOT NULL,
  body VARCHAR(1000) NOT NULL,
  author_id INT UNSIGNED NOT NULL,
  favorites_count TINYINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uq_articles_slug (slug),
  KEY idx_articles_recent (created_at, id),
  KEY idx_articles_author (author_id),
  CONSTRAINT fk_articles_author FOREIGN KEY (author_id) REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE article_tags (
  article_id INT UNSIGNED NOT NULL,
  tag_id SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (article_id, tag_id),
  KEY idx_article_tags_tag (tag_id),
  CONSTRAINT fk_article_tags_article FOREIGN KEY (article_id) REFERENCES articles (id),
  CONSTRAINT fk_article_tags_tag FOREIGN KEY (tag_id) REFERENCES tags (id)
) ENGINE=InnoDB;

CREATE TABLE comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  article_id INT UNSIGNED NOT NULL,
  author_id INT UNSIGNED NOT NULL,
  body VARCHAR(200) NOT NULL,
  created_at DATETIME NOT NULL,
  KEY idx_comments_article (article_id, id),
  KEY idx_comments_author (author_id),
  CONSTRAINT fk_comments_article FOREIGN KEY (article_id) REFERENCES articles (id),
  CONSTRAINT fk_comments_author FOREIGN KEY (author_id) REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE follows (
  follower_id INT UNSIGNED NOT NULL,
  followee_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  KEY idx_follows_followee (followee_id),
  CONSTRAINT fk_follows_follower FOREIGN KEY (follower_id) REFERENCES users (id),
  CONSTRAINT fk_follows_followee FOREIGN KEY (followee_id) REFERENCES users (id)
) ENGINE=InnoDB;

-- One bcrypt cost-10 hash of the public password cwm-bench-password, shared by every user.
INSERT INTO users (id, username, email, bio, image, password_hash)
SELECT n,
       CONCAT('user', n),
       CONCAT('user', n, '@example.test'),
       REPEAT('b', 100),
       'https://example.test/images/avatar.png',
       '$2a$10$q..g2AoRYD9HP3YSeOcPCOajVOU6tj1OwjXDKI.9SSqMP7yM043sS'
FROM (
  SELECT d0.d + d1.d * 10 + d2.d * 100 + 1 AS n
  FROM digits d0
  JOIN digits d1
  JOIN digits d2
) seq;

INSERT INTO tags (id, name)
SELECT n, CONCAT('tag', LPAD(n, 2, '0'))
FROM (
  SELECT d0.d + d1.d * 10 + 1 AS n
  FROM digits d0
  JOIN digits d1
) seq
WHERE n <= 50;

INSERT INTO articles (
  id, slug, title, description, body, author_id, favorites_count, created_at, updated_at
)
SELECT n,
       CONCAT('article-', n),
       REPEAT('t', 60),
       REPEAT('d', 200),
       REPEAT('a', 1000),
       ((n - 1) % 1000) + 1,
       (n * 13) % 100,
       DATE_ADD('2026-01-01 00:00:00', INTERVAL n MINUTE),
       DATE_ADD('2026-01-01 00:00:00', INTERVAL n MINUTE)
FROM (
  SELECT d0.d + d1.d * 10 + d2.d * 100 + d3.d * 1000 + 1 AS n
  FROM digits d0
  JOIN digits d1
  JOIN digits d2
  JOIN digits d3
) seq;

-- 3 distinct tags: offsets 0, 17, and 31 modulo 50.
INSERT INTO article_tags (article_id, tag_id)
SELECT a.id, ((a.id * 3 + offs.off) % 50) + 1
FROM articles a
JOIN (
  SELECT 0 AS off
  UNION ALL SELECT 17
  UNION ALL SELECT 31
) offs;

-- Comment n belongs to article ((n - 1) mod 10000) + 1. Five slots cover 1..50000.
INSERT INTO comments (id, article_id, author_id, body, created_at)
SELECT n,
       ((n - 1) % 10000) + 1,
       ((n * 7) % 1000) + 1,
       REPEAT('c', 200),
       DATE_ADD('2026-01-01 00:00:00', INTERVAL n SECOND)
FROM (
  SELECT a.id + s.slot * 10000 AS n
  FROM articles a
  JOIN (
    SELECT 0 AS slot
    UNION ALL SELECT 1
    UNION ALL SELECT 2
    UNION ALL SELECT 3
    UNION ALL SELECT 4
  ) s
) seq;

-- User u follows ((u - 1 + k * 37) mod 1000) + 1 for k = 1..10.
INSERT INTO follows (follower_id, followee_id)
SELECT u.id, ((u.id - 1 + k.k * 37) % 1000) + 1
FROM users u
JOIN (
  SELECT 1 AS k
  UNION ALL SELECT 2
  UNION ALL SELECT 3
  UNION ALL SELECT 4
  UNION ALL SELECT 5
  UNION ALL SELECT 6
  UNION ALL SELECT 7
  UNION ALL SELECT 8
  UNION ALL SELECT 9
  UNION ALL SELECT 10
) k;

DROP TABLE IF EXISTS digits;
