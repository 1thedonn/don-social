const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'don-secret-key-change-in-production-2024';

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Service Worker и манифест
app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
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
    const extname = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowed.test(file.mimetype);
    if (extname && mimetype) return cb(null, true);
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

function processHashtags(postId, content) {
  const tags = content.match(/#[а-яА-Яa-zA-Z0-9_]+/g) || [];
  db.prepare('DELETE FROM post_hashtags WHERE post_id = ?').run(postId);
  tags.forEach(tag => {
    const tagName = tag.toLowerCase();
    let hashtag = db.prepare('SELECT id FROM hashtags WHERE tag = ?').get(tagName);
    if (!hashtag) {
      const result = db.prepare('INSERT INTO hashtags (tag) VALUES (?)').run(tagName);
      hashtag = { id: result.lastInsertRowid };
    }
    try {
      db.prepare('INSERT INTO post_hashtags (post_id, hashtag_id) VALUES (?, ?)').run(postId, hashtag.id);
    } catch(e) {}
  });
}

function createNotification(toUserId, fromUserId, type, postId = null, commentId = null) {
  if (toUserId === fromUserId) return;
  db.prepare('INSERT INTO notifications (user_id, from_user_id, type, post_id, comment_id) VALUES (?, ?, ?, ?, ?)').run(toUserId, fromUserId, type, postId, commentId);
}

function getPostInfo(postId, userId) {
  return db.prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as likes_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comments_count,
      EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as is_liked,
      EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = ?) as is_bookmarked
    FROM posts p JOIN users u ON p.author_id = u.id
    WHERE p.id = ?
  `).get(userId, userId, postId);
}

function isFollowing(followerId, followingId) {
  return !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(followerId, followingId);
}

// ==================== АУТЕНТИФИКАЦИЯ ====================
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Заполните все поля' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
    if (existing) return res.status(400).json({ error: 'Пользователь уже существует' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, display_name, email, password) VALUES (?, ?, ?, ?)').run(username, username, email, hashedPassword);
    const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: result.lastInsertRowid, username, display_name: username, email, avatar: '/uploads/default-avatar.png', theme: 'light', is_private: 0 } });
  } catch (error) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(400).json({ error: 'Неверный email или пароль' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Неверный email или пароль' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, email: user.email, avatar: user.avatar, bio: user.bio, theme: user.theme, is_private: user.is_private } });
  } catch (error) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/me', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, username, display_name, email, avatar, bio, theme, is_private, pinned_post_id, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// ==================== ПРОФИЛЬ ====================
app.put('/api/profile', authenticateToken, upload.single('avatar'), (req, res) => {
  try {
    const { display_name, bio, theme, is_private } = req.body;
    const updates = [];
    const values = [];
    if (display_name !== undefined) { updates.push('display_name = ?'); values.push(display_name); }
    if (bio !== undefined) { updates.push('bio = ?'); values.push(bio); }
    if (theme !== undefined) { updates.push('theme = ?'); values.push(theme); }
    if (is_private !== undefined) { updates.push('is_private = ?'); values.push(is_private === 'true' || is_private === true ? 1 : 0); }
    if (req.file) { updates.push('avatar = ?'); values.push('/uploads/' + req.file.filename); }
    if (updates.length > 0) { values.push(req.user.id); db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values); }
    const user = db.prepare('SELECT id, username, display_name, email, avatar, bio, theme, is_private, pinned_post_id FROM users WHERE id = ?').get(req.user.id);
    res.json(user);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.put('/api/profile/username', authenticateToken, (req, res) => {
  try {
    const { username } = req.body;
    if (!username || username.length < 3) return res.status(400).json({ error: 'Минимум 3 символа' });
    const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
    if (existing) return res.status(400).json({ error: 'Имя занято' });
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.user.id);
    const user = db.prepare('SELECT id, username, display_name, email, avatar, bio, theme, is_private, pinned_post_id FROM users WHERE id = ?').get(req.user.id);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ user, token });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ПОСТЫ ====================
app.post('/api/posts', authenticateToken, upload.single('image'), (req, res) => {
  try {
    const { content } = req.body;
    const image_url = req.file ? '/uploads/' + req.file.filename : null;
    if (!content && !image_url) return res.status(400).json({ error: 'Пустой пост' });
    const result = db.prepare('INSERT INTO posts (author_id, content, image_url) VALUES (?, ?, ?)').run(req.user.id, content || '', image_url);
    processHashtags(result.lastInsertRowid, content || '');
    const post = getPostInfo(result.lastInsertRowid, req.user.id);
    res.status(201).json(post);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.put('/api/posts/:id', authenticateToken, upload.single('image'), (req, res) => {
  try {
    const post = db.prepare('SELECT * FROM posts WHERE id = ? AND author_id = ?').get(req.params.id, req.user.id);
    if (!post) return res.status(403).json({ error: 'Нельзя редактировать чужой пост' });
    const { content } = req.body;
    const image_url = req.file ? '/uploads/' + req.file.filename : req.body.keep_image ? post.image_url : null;
    db.prepare('UPDATE posts SET content = ?, image_url = ?, edited = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(content || post.content, image_url, req.params.id);
    processHashtags(req.params.id, content || post.content);
    const updated = getPostInfo(req.params.id, req.user.id);
    res.json(updated);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/posts/:id', authenticateToken, (req, res) => {
  try {
    const post = db.prepare('SELECT * FROM posts WHERE id = ? AND author_id = ?').get(req.params.id, req.user.id);
    if (!post) return res.status(403).json({ error: 'Нельзя удалить чужой пост' });
    db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/feed', authenticateToken, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    const currentUserData = db.prepare('SELECT pinned_post_id FROM users WHERE id = ?').get(req.user.id);
    const pinnedId = currentUserData ? currentUserData.pinned_post_id : null;
    
    const posts = db.prepare(`
      SELECT p.*, u.username, u.display_name, u.avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as likes_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comments_count,
        EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as is_liked,
        EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = ?) as is_bookmarked,
        CASE WHEN p.id = ? THEN 1 ELSE 0 END as is_pinned
      FROM posts p JOIN users u ON p.author_id = u.id
      ORDER BY p.created_at DESC LIMIT ? OFFSET ?
    `).all(req.user.id, req.user.id, pinnedId, limit, offset);
    res.json(posts);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/posts/user/:userId', authenticateToken, (req, res) => {
  try {
    const targetUser = db.prepare('SELECT id, is_private FROM users WHERE id = ?').get(req.params.userId);
    if (!targetUser) return res.status(404).json({ error: 'Пользователь не найден' });
    
    // Проверка приватности
    if (targetUser.is_private && targetUser.id !== req.user.id && !isFollowing(req.user.id, targetUser.id)) {
      return res.json({ private: true });
    }
    
    const user = db.prepare('SELECT pinned_post_id FROM users WHERE id = ?').get(req.params.userId);
    const pinnedId = user ? user.pinned_post_id : null;
    const posts = db.prepare(`
      SELECT p.*, u.username, u.display_name, u.avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as likes_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comments_count,
        EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as is_liked,
        EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = ?) as is_bookmarked,
        CASE WHEN p.id = ? THEN 1 ELSE 0 END as is_pinned
      FROM posts p JOIN users u ON p.author_id = u.id
      WHERE p.author_id = ?
      ORDER BY CASE WHEN p.id = ? THEN 0 ELSE 1 END, p.created_at DESC
    `).all(req.user.id, req.user.id, pinnedId, req.params.userId, pinnedId);
    res.json(posts);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/posts/:id/pin', authenticateToken, (req, res) => {
  try {
    const post = db.prepare('SELECT * FROM posts WHERE id = ? AND author_id = ?').get(req.params.id, req.user.id);
    if (!post) return res.status(403).json({ error: 'Не ваш пост' });
    const current = db.prepare('SELECT pinned_post_id FROM users WHERE id = ?').get(req.user.id);
    if (current.pinned_post_id === parseInt(req.params.id)) {
      db.prepare('UPDATE users SET pinned_post_id = NULL WHERE id = ?').run(req.user.id);
      res.json({ pinned: false });
    } else {
      db.prepare('UPDATE users SET pinned_post_id = ? WHERE id = ?').run(req.params.id, req.user.id);
      res.json({ pinned: true });
    }
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ХЕШТЕГИ ====================
app.get('/api/hashtags/:tag', authenticateToken, (req, res) => {
  try {
    const tag = '#' + req.params.tag.toLowerCase();
    const hashtag = db.prepare('SELECT id FROM hashtags WHERE tag = ?').get(tag);
    if (!hashtag) return res.json([]);
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    const posts = db.prepare(`
      SELECT p.*, u.username, u.display_name, u.avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as likes_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comments_count,
        EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as is_liked,
        EXISTS(SELECT 1 FROM bookmarks WHERE post_id = p.id AND user_id = ?) as is_bookmarked
      FROM posts p
      JOIN users u ON p.author_id = u.id
      JOIN post_hashtags ph ON p.id = ph.post_id
      WHERE ph.hashtag_id = ?
      ORDER BY p.created_at DESC LIMIT ? OFFSET ?
    `).all(req.user.id, req.user.id, hashtag.id, limit, offset);
    res.json(posts);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== КОММЕНТАРИИ ====================
app.get('/api/posts/:postId/comments', authenticateToken, (req, res) => {
  try {
    const comments = db.prepare(`
      SELECT c.*, u.username, u.display_name, u.avatar
      FROM comments c JOIN users u ON c.author_id = u.id
      WHERE c.post_id = ? ORDER BY c.created_at ASC
    `).all(req.params.postId);
    res.json(comments);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/posts/:postId/comments', authenticateToken, (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Пустой комментарий' });
    const result = db.prepare('INSERT INTO comments (post_id, author_id, content) VALUES (?, ?, ?)').run(req.params.postId, req.user.id, content.trim());
    const post = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(req.params.postId);
    if (post) createNotification(post.author_id, req.user.id, 'comment', parseInt(req.params.postId), result.lastInsertRowid);
    const comment = db.prepare('SELECT c.*, u.username, u.display_name, u.avatar FROM comments c JOIN users u ON c.author_id = u.id WHERE c.id = ?').get(result.lastInsertRowid);
    res.status(201).json(comment);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/comments/:id', authenticateToken, (req, res) => {
  try {
    const comment = db.prepare('SELECT * FROM comments WHERE id = ? AND author_id = ?').get(req.params.id, req.user.id);
    if (!comment) return res.status(403).json({ error: 'Нельзя удалить' });
    db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ЛАЙКИ ====================
app.post('/api/posts/:postId/like', authenticateToken, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM likes WHERE user_id = ? AND post_id = ?').get(req.user.id, req.params.postId);
    if (existing) {
      db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, req.params.postId);
      res.json({ liked: false });
    } else {
      db.prepare('INSERT INTO likes (user_id, post_id) VALUES (?, ?)').run(req.user.id, req.params.postId);
      const post = db.prepare('SELECT author_id FROM posts WHERE id = ?').get(req.params.postId);
      if (post) createNotification(post.author_id, req.user.id, 'like', parseInt(req.params.postId));
      res.json({ liked: true });
    }
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ЗАКЛАДКИ ====================
app.post('/api/posts/:postId/bookmark', authenticateToken, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND post_id = ?').get(req.user.id, req.params.postId);
    if (existing) {
      db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?').run(req.user.id, req.params.postId);
      res.json({ bookmarked: false });
    } else {
      db.prepare('INSERT INTO bookmarks (user_id, post_id) VALUES (?, ?)').run(req.user.id, req.params.postId);
      res.json({ bookmarked: true });
    }
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/bookmarks', authenticateToken, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    const posts = db.prepare(`
      SELECT p.*, u.username, u.display_name, u.avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as likes_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comments_count,
        EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as is_liked,
        1 as is_bookmarked
      FROM posts p
      JOIN users u ON p.author_id = u.id
      JOIN bookmarks b ON p.id = b.post_id AND b.user_id = ?
      ORDER BY b.created_at DESC LIMIT ? OFFSET ?
    `).all(req.user.id, req.user.id, limit, offset);
    res.json(posts);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ПОДПИСКИ И ЗАЯВКИ ====================
app.post('/api/users/:userId/follow', authenticateToken, (req, res) => {
  try {
    if (req.user.id === parseInt(req.params.userId)) return res.status(400).json({ error: 'Нельзя подписаться на себя' });
    
    const targetUser = db.prepare('SELECT id, is_private FROM users WHERE id = ?').get(req.params.userId);
    if (!targetUser) return res.status(404).json({ error: 'Пользователь не найден' });
    
    const existing = db.prepare('SELECT * FROM follows WHERE follower_id = ? AND following_id = ?').get(req.user.id, req.params.userId);
    if (existing) {
      db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.user.id, req.params.userId);
      db.prepare('DELETE FROM follow_requests WHERE follower_id = ? AND following_id = ?').run(req.user.id, req.params.userId);
      res.json({ following: false });
    } else {
      if (targetUser.is_private) {
        // Отправляем заявку
        const existingReq = db.prepare('SELECT * FROM follow_requests WHERE follower_id = ? AND following_id = ?').get(req.user.id, req.params.userId);
        if (!existingReq) {
          db.prepare('INSERT INTO follow_requests (follower_id, following_id) VALUES (?, ?)').run(req.user.id, req.params.userId);
          createNotification(req.params.userId, req.user.id, 'follow_request');
        }
        res.json({ requested: true });
      } else {
        db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)').run(req.user.id, req.params.userId);
        createNotification(parseInt(req.params.userId), req.user.id, 'follow');
        res.json({ following: true });
      }
    }
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// Принять/отклонить заявку
app.post('/api/follow-requests/:requestId/:action', authenticateToken, (req, res) => {
  try {
    const { requestId, action } = req.params;
    const fr = db.prepare('SELECT * FROM follow_requests WHERE id = ? AND following_id = ?').get(requestId, req.user.id);
    if (!fr) return res.status(404).json({ error: 'Заявка не найдена' });
    
    if (action === 'accept') {
      db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)').run(fr.follower_id, fr.following_id);
      createNotification(fr.follower_id, req.user.id, 'follow_accept');
    }
    db.prepare('DELETE FROM follow_requests WHERE id = ?').run(requestId);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// Заявки на подписку (для текущего пользователя)
app.get('/api/follow-requests', authenticateToken, (req, res) => {
  try {
    const requests = db.prepare(`
      SELECT fr.id, fr.follower_id, fr.created_at, u.username, u.display_name, u.avatar
      FROM follow_requests fr
      JOIN users u ON fr.follower_id = u.id
      WHERE fr.following_id = ?
      ORDER BY fr.created_at DESC
    `).all(req.user.id);
    res.json(requests);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/users/:userId', authenticateToken, (req, res) => {
  try {
    const user = db.prepare('SELECT id, username, display_name, email, avatar, bio, theme, is_private, pinned_post_id, created_at FROM users WHERE id = ?').get(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const followersCount = db.prepare('SELECT COUNT(*) as count FROM follows WHERE following_id = ?').get(req.params.userId).count;
    const followingCount = db.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').get(req.params.userId).count;
    const postsCount = db.prepare('SELECT COUNT(*) as count FROM posts WHERE author_id = ?').get(req.params.userId).count;
    const isFollowing = !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(req.user.id, req.params.userId);
    const hasRequested = !!db.prepare('SELECT 1 FROM follow_requests WHERE follower_id = ? AND following_id = ?').get(req.user.id, req.params.userId);
    res.json({ ...user, followers_count: followersCount, following_count: followingCount, posts_count: postsCount, is_following: isFollowing, has_requested: hasRequested });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/users/search', authenticateToken, (req, res) => {
  try {
    const query = req.query.q || '';
    const users = db.prepare('SELECT id, username, display_name, avatar, is_private FROM users WHERE username LIKE ? OR display_name LIKE ? LIMIT 10').all(`%${query}%`, `%${query}%`);
    res.json(users);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/users/suggested', authenticateToken, (req, res) => {
  try {
    const users = db.prepare('SELECT id, username, display_name, avatar, is_private FROM users WHERE id != ? AND id NOT IN (SELECT following_id FROM follows WHERE follower_id = ?) ORDER BY RANDOM() LIMIT 5').all(req.user.id, req.user.id);
    res.json(users);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/users/:userId/followers', authenticateToken, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = ? AND following_id = u.id) as is_following
      FROM follows f JOIN users u ON f.follower_id = u.id
      WHERE f.following_id = ?
      ORDER BY f.created_at DESC
    `).all(req.user.id, req.params.userId);
    res.json(users);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/users/:userId/following', authenticateToken, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar, 1 as is_following
      FROM follows f JOIN users u ON f.following_id = u.id
      WHERE f.follower_id = ?
      ORDER BY f.created_at DESC
    `).all(req.params.userId);
    res.json(users);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== СООБЩЕНИЯ ====================
// Получить список чатов
app.get('/api/messages/chats', authenticateToken, (req, res) => {
  try {
    const chats = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar,
        (SELECT content FROM messages WHERE (from_user_id = ? AND to_user_id = u.id) OR (from_user_id = u.id AND to_user_id = ?) ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM messages WHERE (from_user_id = ? AND to_user_id = u.id) OR (from_user_id = u.id AND to_user_id = ?) ORDER BY created_at DESC LIMIT 1) as last_time,
        (SELECT COUNT(*) FROM messages WHERE to_user_id = ? AND from_user_id = u.id AND read = 0) as unread
      FROM users u
      WHERE u.id != ? AND (
        EXISTS(SELECT 1 FROM messages WHERE from_user_id = ? AND to_user_id = u.id)
        OR EXISTS(SELECT 1 FROM messages WHERE from_user_id = u.id AND to_user_id = ?)
      )
      ORDER BY last_time DESC
    `).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
    res.json(chats);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// Получить сообщения с пользователем
app.get('/api/messages/:userId', authenticateToken, (req, res) => {
  try {
    db.prepare('UPDATE messages SET read = 1 WHERE to_user_id = ? AND from_user_id = ? AND read = 0').run(req.user.id, req.params.userId);
    const messages = db.prepare(`
      SELECT m.*, u.username, u.display_name, u.avatar
      FROM messages m JOIN users u ON m.from_user_id = u.id
      WHERE (m.from_user_id = ? AND m.to_user_id = ?) OR (m.from_user_id = ? AND m.to_user_id = ?)
      ORDER BY m.created_at ASC
      LIMIT 100
    `).all(req.user.id, req.params.userId, req.params.userId, req.user.id);
    res.json(messages);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// Отправить сообщение
app.post('/api/messages/:userId', authenticateToken, (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Пустое сообщение' });
    const result = db.prepare('INSERT INTO messages (from_user_id, to_user_id, content) VALUES (?, ?, ?)').run(req.user.id, req.params.userId, content.trim());
    createNotification(parseInt(req.params.userId), req.user.id, 'message');
    const message = db.prepare('SELECT m.*, u.username, u.display_name, u.avatar FROM messages m JOIN users u ON m.from_user_id = u.id WHERE m.id = ?').get(result.lastInsertRowid);
    res.status(201).json(message);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== УВЕДОМЛЕНИЯ ====================
app.get('/api/notifications', authenticateToken, (req, res) => {
  try {
    const notifications = db.prepare(`
      SELECT n.*, u.username, u.display_name, u.avatar
      FROM notifications n JOIN users u ON n.from_user_id = u.id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC LIMIT 30
    `).all(req.user.id);
    res.json(notifications);
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/notifications/unread-count', authenticateToken, (req, res) => {
  try {
    const result = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0').get(req.user.id);
    const msgCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE to_user_id = ? AND read = 0').get(req.user.id);
    res.json({ count: result.count + msgCount.count });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/notifications/read-all', authenticateToken, (req, res) => {
  try {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

// ==================== ПРОСМОТРЫ ====================
app.post('/api/posts/:id/view', authenticateToken, (req, res) => {
  try {
    db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Ошибка' }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 don запущен на http://localhost:${PORT}`);
});