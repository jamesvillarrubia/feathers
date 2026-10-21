DROP TABLE IF EXISTS messages, users;

CREATE TABLE users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password text NOT NULL
);

CREATE TABLE messages (
  id serial PRIMARY KEY,
  text text NOT NULL
);

INSERT INTO messages (text) VALUES ('hello from Postgres');
