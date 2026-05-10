const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const pool = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'don-secret-key-change-in-production-2024';

const uploadsDir = process.env.RENDER ? '/opt/render/project/src/uploads' : 'uploads';
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir + '/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|mov|avi|webm/;
    if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('Неверный формат файла'));
  }
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Неверный токен' });
    req.user = user;
    next();
  });
};

async function processHashtags(postId, content) {
  const tags = content.match(/#[а-яА-Яa-zA-Z0-9_]+/g) || [];
  await pool.query('DELETE FROM post_hashtags WHERE post_id = $1', [postId]);
  for (const tag of tags) {
    const tagName = tag.toLowerCase();
    let result = await pool.query('SELECT id FROM hashtags WHERE tag = $1', [tagName]);
    let tagId;
    if (result.rows.length === 0) {
      const insert = await pool.query('INSERT INTO hashtags (tag) VALUES ($1) RETURNING id', [tagName]);
      tagId = insert.rows[0].id;
    } else {
      tagId = result.rows[0].id;
    }
    try {
      await pool.query('INSERT INTO post_hashtags (post_id, hashtag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [postId, tagId]);
    } catch(e) {}
  }
}

async function createNotification(toUserId, fromUserId, type, postId = null, commentId = null) {
  if (toUserId === fromUserId) return;
  await pool.query('INSERT INTO notifications (user_id, from_user_id, type, post_id, comment_id) VALUES ($1, $2, $3, $4, $5)', [toUserId, fromUserId, type, postId, commentId]);
}

async function getPostInfo(postId, userId) {
  const result = await pool.query(`
    SELECT p.*, u.username, u.display_name, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as likes_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comments_count,
      EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $2) as is_liked,
      EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = $3) as is_bookmarked
    FROM posts p JOIN users u ON p.author_id = u.id
    WHERE p.id = $1
  `, [postId, userId, userId]);
  return result.rows[0];
}

function isFollowing(followerId, followingId) {
  return pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [followerId, followingId]).then(r => r.rows.length > 0);
}

// ==================== АУТЕНТИФИКАЦИЯ ====================
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Заполните все поля' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    const existing = await pool.query('SELECT id FROM users WHERE email = $1 OR username = $2', [email, username]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Пользователь уже существует' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users (username, display_name, email, password) VALUES ($1, $2, $3, $4) RETURNING id', [username, username, email, hashedPassword]);
    const token = jwt.sign({ id: result.rows[0].id, username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: result.rows[0].id, username, display_name: username, email, avatar: '/uploads/default-avatar.png', theme: 'light', is_private: 0 } });
  } catch (error) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Неверный email или пароль' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Неверный email или пароль' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, email: user.email, avatar: user.avatar, bio: user.bio, theme: user.theme, is_private: user.is_private } });
  } catch (error) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/me', authenticateToken, async (req, res) => {
  const result = await pool.query('SELECT id, username, display_name, email, avatar, bio, theme, is_private, pinned_post_id, created_at FROM users WHERE id = $1', [req.user.id]);
  res.json(result.rows[0]);
});

// ==================== ПРОФИЛЬ ====================
app.put('/api/profile', authenticateToken, upload.single('avatar'), async (req, res) => {
  try {
    const { display_name, bio, theme, is_private } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 0;
    
    if (display_name !== undefined) { paramCount++; updates.push(`display_name = $${paramCount}`); values.push(display_name); }
    if (bio !== undefined) { paramCount++; updates.push(`bio = $${paramCount}`); values.push(bio); }
    if (theme !== undefined) { paramCount++; updates.push(`theme = $${paramCount}`); values.push(theme); }
    if (is_private !== undefined) { paramCount++; updates.push(`is_private = $${paramCount}`); values.push(is_private === 'true' || is_private === true ? 1 : 0); }
    if (req.file) { paramCount++; updates.push(`avatar = $${paramCount}`); values.push('/uploads/' + req.file.filename); }
    
    if (updates.length > 0) {
      paramCount++;
      values.push(req.user.id);
      await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount}`, values);
    }
    const result = await pool.query('SELECT id, username, display_name, email, avatar, bio, theme, is_private, pinned_post_id FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.put('/api/profile/username', authenticateToken, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || username.length < 3) return res.status(400).json({ error: 'Минимум 3 символа' });
    const existing = await pool.query('SELECT id FROM users WHERE username = $1 AND id != $2', [username, req.user.id]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Имя занято' });
    await pool.query('UPDATE users SET username = $1 WHERE id = $2', [username, req.user.id]);
    const result = await pool.query('SELECT id, username, display_name, email, avatar, bio, theme, is_private, pinned_post_id FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user, token });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ПОСТЫ ====================
app.post('/api/posts', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { content } = req.body;
    const image_url = req.file ? '/uploads/' + req.file.filename : null;
    if (!content && !image_url) return res.status(400).json({ error: 'Пустой пост' });
    const result = await pool.query('INSERT INTO posts (author_id, content, image_url) VALUES ($1, $2, $3) RETURNING id', [req.user.id, content || '', image_url]);
    await processHashtags(result.rows[0].id, content || '');
    const post = await getPostInfo(result.rows[0].id, req.user.id);
    res.status(201).json(post);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.put('/api/posts/:id', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const post = await pool.query('SELECT * FROM posts WHERE id = $1 AND author_id = $2', [req.params.id, req.user.id]);
    if (post.rows.length === 0) return res.status(403).json({ error: 'Нельзя редактировать чужой пост' });
    const { content } = req.body;
    const image_url = req.file ? '/uploads/' + req.file.filename : req.body.keep_image ? post.rows[0].image_url : null;
    await pool.query('UPDATE posts SET content = $1, image_url = $2, edited = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [content || post.rows[0].content, image_url, req.params.id]);
    await processHashtags(req.params.id, content || post.rows[0].content);
    const updated = await getPostInfo(req.params.id, req.user.id);
    res.json(updated);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
  try {
    const post = await pool.query('SELECT * FROM posts WHERE id = $1 AND author_id = $2', [req.params.id, req.user.id]);
    if (post.rows.length === 0) return res.status(403).json({ error: 'Нельзя удалить чужой пост' });
    await pool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/feed', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    const userData = await pool.query('SELECT pinned_post_id FROM users WHERE id = $1', [req.user.id]);
    const pinnedId = userData.rows[0]?.pinned_post_id || null;
    
    const result = await pool.query(`
      SELECT p.*, u.username, u.display_name, u.avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as likes_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comments_count,
        EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $1) as is_liked,
        EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = $2) as is_bookmarked,
        CASE WHEN p.id = $3 THEN 1 ELSE 0 END as is_pinned
      FROM posts p JOIN users u ON p.author_id = u.id
      ORDER BY p.created_at DESC LIMIT $4 OFFSET $5
    `, [req.user.id, req.user.id, pinnedId, limit, offset]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/posts/user/:userId', authenticateToken, async (req, res) => {
  try {
    const targetUser = await pool.query('SELECT id, is_private FROM users WHERE id = $1', [req.params.userId]);
    if (targetUser.rows.length === 0) return res.status(404).json({ error: 'Не найден' });
    
    if (targetUser.rows[0].is_private && targetUser.rows[0].id !== req.user.id) {
      const following = await isFollowing(req.user.id, targetUser.rows[0].id);
      if (!following) return res.json({ private: true });
    }
    
    const userData = await pool.query('SELECT pinned_post_id FROM users WHERE id = $1', [req.params.userId]);
    const pinnedId = userData.rows[0]?.pinned_post_id || null;
    
    const result = await pool.query(`
      SELECT p.*, u.username, u.display_name, u.avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as likes_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comments_count,
        EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $1) as is_liked,
        EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = $2) as is_bookmarked,
        CASE WHEN p.id = $3 THEN 1 ELSE 0 END as is_pinned
      FROM posts p JOIN users u ON p.author_id = u.id
      WHERE p.author_id = $4
      ORDER BY CASE WHEN p.id = $5 THEN 0 ELSE 1 END, p.created_at DESC
    `, [req.user.id, req.user.id, pinnedId, req.params.userId, pinnedId]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/posts/:id/view', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE posts SET views = views + 1 WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/posts/:id/pin', authenticateToken, async (req, res) => {
  try {
    const post = await pool.query('SELECT * FROM posts WHERE id = $1 AND author_id = $2', [req.params.id, req.user.id]);
    if (post.rows.length === 0) return res.status(403).json({ error: 'Не ваш пост' });
    const current = await pool.query('SELECT pinned_post_id FROM users WHERE id = $1', [req.user.id]);
    if (current.rows[0].pinned_post_id === parseInt(req.params.id)) {
      await pool.query('UPDATE users SET pinned_post_id = NULL WHERE id = $1', [req.user.id]);
      res.json({ pinned: false });
    } else {
      await pool.query('UPDATE users SET pinned_post_id = $1 WHERE id = $2', [req.params.id, req.user.id]);
      res.json({ pinned: true });
    }
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ХЕШТЕГИ ====================
app.get('/api/hashtags/:tag', authenticateToken, async (req, res) => {
  try {
    const tag = '#' + req.params.tag.toLowerCase();
    const hashtag = await pool.query('SELECT id FROM hashtags WHERE tag = $1', [tag]);
    if (hashtag.rows.length === 0) return res.json([]);
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    const result = await pool.query(`
      SELECT p.*, u.username, u.display_name, u.avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as likes_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comments_count,
        EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $1) as is_liked,
        EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = $2) as is_bookmarked
      FROM posts p
      JOIN users u ON p.author_id = u.id
      JOIN post_hashtags ph ON p.id = ph.post_id
      WHERE ph.hashtag_id = $3
      ORDER BY p.created_at DESC LIMIT $4 OFFSET $5
    `, [req.user.id, req.user.id, hashtag.rows[0].id, limit, offset]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== КОММЕНТАРИИ ====================
app.get('/api/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT c.*, u.username, u.display_name, u.avatar FROM comments c JOIN users u ON c.author_id = u.id WHERE c.post_id = $1 ORDER BY c.created_at ASC', [req.params.postId]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/posts/:postId/comments', authenticateToken, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Пустой комментарий' });
    const result = await pool.query('INSERT INTO comments (post_id, author_id, content) VALUES ($1, $2, $3) RETURNING id', [req.params.postId, req.user.id, content.trim()]);
    const post = await pool.query('SELECT author_id FROM posts WHERE id = $1', [req.params.postId]);
    if (post.rows.length > 0) await createNotification(post.rows[0].author_id, req.user.id, 'comment', parseInt(req.params.postId), result.rows[0].id);
    const comment = await pool.query('SELECT c.*, u.username, u.display_name, u.avatar FROM comments c JOIN users u ON c.author_id = u.id WHERE c.id = $1', [result.rows[0].id]);
    res.status(201).json(comment.rows[0]);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/comments/:id', authenticateToken, async (req, res) => {
  try {
    const comment = await pool.query('SELECT * FROM comments WHERE id = $1 AND author_id = $2', [req.params.id, req.user.id]);
    if (comment.rows.length === 0) return res.status(403).json({ error: 'Нельзя удалить' });
    await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ЛАЙКИ ====================
app.post('/api/posts/:postId/like', authenticateToken, async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM likes WHERE user_id = $1 AND post_id = $2', [req.user.id, req.params.postId]);
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM likes WHERE user_id = $1 AND post_id = $2', [req.user.id, req.params.postId]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO likes (user_id, post_id) VALUES ($1, $2)', [req.user.id, req.params.postId]);
      const post = await pool.query('SELECT author_id FROM posts WHERE id = $1', [req.params.postId]);
      if (post.rows.length > 0) await createNotification(post.rows[0].author_id, req.user.id, 'like', parseInt(req.params.postId));
      res.json({ liked: true });
    }
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ЗАКЛАДКИ ====================
app.post('/api/posts/:postId/bookmark', authenticateToken, async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM bookmarks WHERE user_id = $1 AND post_id = $2', [req.user.id, req.params.postId]);
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM bookmarks WHERE user_id = $1 AND post_id = $2', [req.user.id, req.params.postId]);
      res.json({ bookmarked: false });
    } else {
      await pool.query('INSERT INTO bookmarks (user_id, post_id) VALUES ($1, $2)', [req.user.id, req.params.postId]);
      res.json({ bookmarked: true });
    }
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/bookmarks', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    const result = await pool.query(`
      SELECT p.*, u.username, u.display_name, u.avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as likes_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comments_count,
        EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $1) as is_liked,
        1 as is_bookmarked
      FROM posts p
      JOIN users u ON p.author_id = u.id
      JOIN bookmarks b ON p.id = b.post_id AND b.user_id = $2
      ORDER BY b.created_at DESC LIMIT $3 OFFSET $4
    `, [req.user.id, req.user.id, limit, offset]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ПОДПИСКИ ====================
app.post('/api/users/:userId/follow', authenticateToken, async (req, res) => {
  try {
    if (req.user.id === parseInt(req.params.userId)) return res.status(400).json({ error: 'Нельзя подписаться на себя' });
    const targetUser = await pool.query('SELECT id, is_private FROM users WHERE id = $1', [req.params.userId]);
    if (targetUser.rows.length === 0) return res.status(404).json({ error: 'Не найден' });

    const existing = await pool.query('SELECT * FROM follows WHERE follower_id = $1 AND following_id = $2', [req.user.id, req.params.userId]);
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM follows WHERE follower_id = $1 AND following_id = $2', [req.user.id, req.params.userId]);
      await pool.query('DELETE FROM follow_requests WHERE follower_id = $1 AND following_id = $2', [req.user.id, req.params.userId]);
      res.json({ following: false });
    } else {
      if (targetUser.rows[0].is_private) {
        const existingReq = await pool.query('SELECT * FROM follow_requests WHERE follower_id = $1 AND following_id = $2', [req.user.id, req.params.userId]);
        if (existingReq.rows.length === 0) {
          await pool.query('INSERT INTO follow_requests (follower_id, following_id) VALUES ($1, $2)', [req.user.id, req.params.userId]);
          await createNotification(req.params.userId, req.user.id, 'follow_request');
        }
        res.json({ requested: true });
      } else {
        await pool.query('INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)', [req.user.id, req.params.userId]);
        await createNotification(parseInt(req.params.userId), req.user.id, 'follow');
        res.json({ following: true });
      }
    }
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/follow-requests/:requestId/:action', authenticateToken, async (req, res) => {
  try {
    const fr = await pool.query('SELECT * FROM follow_requests WHERE id = $1 AND following_id = $2', [req.params.requestId, req.user.id]);
    if (fr.rows.length === 0) return res.status(404).json({ error: 'Заявка не найдена' });
    if (req.params.action === 'accept') {
      await pool.query('INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fr.rows[0].follower_id, fr.rows[0].following_id]);
      await createNotification(fr.rows[0].follower_id, req.user.id, 'follow_accept');
    }
    await pool.query('DELETE FROM follow_requests WHERE id = $1', [req.params.requestId]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/follow-requests', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT fr.id, fr.follower_id, fr.created_at, u.username, u.display_name, u.avatar FROM follow_requests fr JOIN users u ON fr.follower_id = u.id WHERE fr.following_id = $1 ORDER BY fr.created_at DESC', [req.user.id]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/users/:userId', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query('SELECT id, username, display_name, email, avatar, bio, theme, is_private, pinned_post_id, created_at FROM users WHERE id = $1', [req.params.userId]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'Не найден' });
    const f1 = await pool.query('SELECT COUNT(*) as count FROM follows WHERE following_id = $1', [req.params.userId]);
    const f2 = await pool.query('SELECT COUNT(*) as count FROM follows WHERE follower_id = $1', [req.params.userId]);
    const p = await pool.query('SELECT COUNT(*) as count FROM posts WHERE author_id = $1', [req.params.userId]);
    const isF = await isFollowing(req.user.id, req.params.userId);
    const hasR = await pool.query('SELECT 1 FROM follow_requests WHERE follower_id = $1 AND following_id = $2', [req.user.id, req.params.userId]);
    res.json({ ...user.rows[0], followers_count: parseInt(f1.rows[0].count), following_count: parseInt(f2.rows[0].count), posts_count: parseInt(p.rows[0].count), is_following: isF, has_requested: hasR.rows.length > 0 });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/users/search', authenticateToken, async (req, res) => {
  try {
    const query = req.query.q || '';
    const result = await pool.query('SELECT id, username, display_name, avatar, is_private FROM users WHERE username ILIKE $1 OR display_name ILIKE $1 LIMIT 10', [`%${query}%`]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/users/suggested', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, display_name, avatar, is_private FROM users WHERE id != $1 AND id NOT IN (SELECT following_id FROM follows WHERE follower_id = $2) ORDER BY RANDOM() LIMIT 5', [req.user.id, req.user.id]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/users/:userId/followers', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT u.id, u.username, u.display_name, u.avatar, EXISTS(SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = u.id) as is_following FROM follows f JOIN users u ON f.follower_id = u.id WHERE f.following_id = $2 ORDER BY f.created_at DESC', [req.user.id, req.params.userId]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/users/:userId/following', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT u.id, u.username, u.display_name, u.avatar, 1 as is_following FROM follows f JOIN users u ON f.following_id = u.id WHERE f.follower_id = $1 ORDER BY f.created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== СООБЩЕНИЯ ====================
app.get('/api/messages/chats', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.avatar,
        (SELECT content FROM messages WHERE (from_user_id = $1 AND to_user_id = u.id) OR (from_user_id = u.id AND to_user_id = $2) ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM messages WHERE (from_user_id = $3 AND to_user_id = u.id) OR (from_user_id = u.id AND to_user_id = $4) ORDER BY created_at DESC LIMIT 1) as last_time,
        (SELECT COUNT(*) FROM messages WHERE to_user_id = $5 AND from_user_id = u.id AND read = 0) as unread
      FROM users u
      WHERE u.id != $6 AND (
        EXISTS(SELECT 1 FROM messages WHERE from_user_id = $7 AND to_user_id = u.id)
        OR EXISTS(SELECT 1 FROM messages WHERE from_user_id = u.id AND to_user_id = $8)
      )
      ORDER BY last_time DESC
    `, [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/messages/:userId', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE messages SET read = 1 WHERE to_user_id = $1 AND from_user_id = $2 AND read = 0', [req.user.id, req.params.userId]);
    const result = await pool.query('SELECT m.*, u.username, u.display_name, u.avatar FROM messages m JOIN users u ON m.from_user_id = u.id WHERE (m.from_user_id = $1 AND m.to_user_id = $2) OR (m.from_user_id = $3 AND m.to_user_id = $4) ORDER BY m.created_at ASC LIMIT 100', [req.user.id, req.params.userId, req.params.userId, req.user.id]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/messages/:userId', authenticateToken, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Пустое сообщение' });
    const result = await pool.query('INSERT INTO messages (from_user_id, to_user_id, content) VALUES ($1, $2, $3) RETURNING id', [req.user.id, req.params.userId, content.trim()]);
    await createNotification(parseInt(req.params.userId), req.user.id, 'message');
    const msg = await pool.query('SELECT m.*, u.username, u.display_name, u.avatar FROM messages m JOIN users u ON m.from_user_id = u.id WHERE m.id = $1', [result.rows[0].id]);
    res.status(201).json(msg.rows[0]);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== УВЕДОМЛЕНИЯ ====================
app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT n.*, u.username, u.display_name, u.avatar FROM notifications n JOIN users u ON n.from_user_id = u.id WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 30', [req.user.id]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/notifications/unread-count', authenticateToken, async (req, res) => {
  try {
    const r1 = await pool.query('SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND read = 0', [req.user.id]);
    const r2 = await pool.query('SELECT COUNT(*) as count FROM messages WHERE to_user_id = $1 AND read = 0', [req.user.id]);
    res.json({ count: parseInt(r1.rows[0].count) + parseInt(r2.rows[0].count) });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/notifications/read-all', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read = 1 WHERE user_id = $1', [req.user.id]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ТЕСТ ====================
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 don запущен на порту ${PORT}`);
});