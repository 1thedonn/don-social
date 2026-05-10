const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/don',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const initDB = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT DEFAULT '',
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT DEFAULT '/uploads/default-avatar.png',
        bio TEXT DEFAULT '',
        theme TEXT DEFAULT 'light',
        is_private INTEGER DEFAULT 0,
        pinned_post_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS follow_requests (
        id SERIAL PRIMARY KEY,
        follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(follower_id, following_id)
      );
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        image_url TEXT,
        views INTEGER DEFAULT 0,
        edited INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS likes (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, post_id)
      );
      CREATE TABLE IF NOT EXISTS follows (
        follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (follower_id, following_id)
      );
      CREATE TABLE IF NOT EXISTS bookmarks (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, post_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        post_id INTEGER,
        comment_id INTEGER,
        read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS hashtags (
        id SERIAL PRIMARY KEY,
        tag TEXT UNIQUE NOT NULL
      );
      CREATE TABLE IF NOT EXISTS post_hashtags (
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        hashtag_id INTEGER NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
        PRIMARY KEY (post_id, hashtag_id)
      );
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
};

initDB().catch(console.error);

module.exports = pool;