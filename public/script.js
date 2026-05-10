const API_URL = '/api';
let currentUser = null;
let token = localStorage.getItem('token');
let currentPage = 'feed';
let currentProfileId = null;
let feedPage = 1;
let bookmarksPage = 1;
let hashtagPage = 1;
let hasMoreFeed = true;
let hasMoreBookmarks = true;
let hasMoreHashtag = true;
let currentHashtag = null;
let currentPostForComments = null;
let currentPostForEdit = null;
let isLoadingMore = false;
let unreadCount = 0;
let notificationsOpen = false;
let currentChatUserId = null;
let chatsRefreshInterval = null;

document.addEventListener('DOMContentLoaded', () => {
    // Регистрация Service Worker для PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  if (token) checkAuth();
  setupAuthListeners();
});


function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  if (currentUser) {
    fetch(`${API_URL}/profile`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next })
    }).catch(() => {});
  }
}

function setupAuthListeners() {
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab + '-form').classList.add('active');
    });
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    try {
      const res = await fetch(API_URL + '/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (res.ok) { token = data.token; localStorage.setItem('token', token); currentUser = data.user; showApp(); }
      else { document.getElementById('login-error').textContent = data.error; }
    } catch { document.getElementById('login-error').textContent = 'Ошибка соединения'; }
  });

  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('reg-username').value;
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;
    try {
      const res = await fetch(API_URL + '/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password })
      });
      const data = await res.json();
      if (res.ok) { token = data.token; localStorage.setItem('token', token); currentUser = data.user; showApp(); }
      else { document.getElementById('register-error').textContent = data.error; }
    } catch { document.getElementById('register-error').textContent = 'Ошибка соединения'; }
  });
}

async function checkAuth() {
  try {
    const res = await fetch(API_URL + '/me', { headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) { currentUser = await res.json(); showApp(); }
    else { localStorage.removeItem('token'); token = null; }
  } catch {}
}

function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  setupAppListeners();
  document.getElementById('current-user-avatar').src = currentUser.avatar || '/uploads/default-avatar.png';
  document.getElementById('my-profile-link').dataset.userId = currentUser.id;
  applyTheme(currentUser.theme || 'light');
  loadUnreadCount();
  navigateTo('feed');
  setInterval(loadUnreadCount, 15000);
}

function logout() {
  localStorage.removeItem('token'); token = null; currentUser = null;
  if (chatsRefreshInterval) clearInterval(chatsRefreshInterval);
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display = 'none';
}

function setupAppListeners() {
  document.querySelectorAll('.nav-links a').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const page = link.dataset.page;
      if (page === 'profile') navigateTo('profile', currentUser.id);
      else navigateTo(page);
    });
  });

  document.getElementById('theme-toggle').onclick = toggleTheme;
  document.getElementById('logout-btn').onclick = logout;
  document.getElementById('notifications-btn').onclick = toggleNotifications;

  const searchInput = document.getElementById('search-input');
  let searchTimeout;
  searchInput.onfocus = () => {
    const query = searchInput.value.trim();
    if (query.length === 0) showSuggestedInSearch();
    else if (query.length >= 1) searchUsers(query);
  };
  searchInput.oninput = () => {
    clearTimeout(searchTimeout);
    const query = searchInput.value.trim();
    if (query.length === 0) showSuggestedInSearch();
    else if (query.length >= 1) searchTimeout = setTimeout(() => searchUsers(query), 300);
  };

  document.onclick = (e) => {
    if (!e.target.closest('.search-bar')) document.getElementById('search-results').innerHTML = '';
    if (!e.target.closest('.post-menu')) document.querySelectorAll('.post-menu-dropdown.show').forEach(d => d.classList.remove('show'));
    if (!e.target.closest('.notifications-wrapper') && notificationsOpen) {
      document.getElementById('notifications-dropdown').classList.remove('show');
      notificationsOpen = false;
    }
  };

  document.getElementById('create-post-form').onsubmit = createPost;
  document.getElementById('post-image').onchange = previewMedia;
  document.getElementById('comment-form').onsubmit = addComment;
  document.getElementById('chat-input-form').onsubmit = sendMessage;
  document.getElementById('comments-modal').onclick = (e) => { if (e.target === e.currentTarget) closeComments(); };
  document.getElementById('edit-post-modal').onclick = (e) => { if (e.target === e.currentTarget) closeEditPost(); };
  document.getElementById('follows-modal').onclick = (e) => { if (e.target === e.currentTarget) closeFollowsModal(); };
  document.getElementById('requests-modal').onclick = (e) => { if (e.target === e.currentTarget) closeRequestsModal(); };

  window.onscroll = () => {
    if (isLoadingMore) return;
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) loadMore();
  };
}

function navigateTo(page, userId = null) {
  if (chatsRefreshInterval && page !== 'messages') { clearInterval(chatsRefreshInterval); chatsRefreshInterval = null; }
  
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(page + '-page').classList.add('active');
  currentPage = page;
  
  if (page === 'feed') { feedPage = 1; hasMoreFeed = true; document.getElementById('feed-posts').innerHTML = ''; loadFeed(); }
  else if (page === 'bookmarks') { bookmarksPage = 1; hasMoreBookmarks = true; document.getElementById('bookmarks-posts').innerHTML = ''; loadBookmarks(); }
  else if (page === 'messages') { loadChats(); chatsRefreshInterval = setInterval(loadChats, 5000); }
  else if (page === 'profile' && userId) { currentProfileId = userId; document.getElementById('profile-posts').innerHTML = ''; loadProfile(userId); }
}

function navigateToHashtag(tag) {
  currentHashtag = tag.replace('#', '');
  hashtagPage = 1; hasMoreHashtag = true;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('hashtag-page').classList.add('active');
  document.getElementById('hashtag-title').textContent = '#' + currentHashtag;
  document.getElementById('hashtag-posts').innerHTML = '';
  currentPage = 'hashtag';
  loadHashtagPosts();
}

function loadMore() {
  if (currentPage === 'feed' && hasMoreFeed) { feedPage++; loadFeed(true); }
  else if (currentPage === 'bookmarks' && hasMoreBookmarks) { bookmarksPage++; loadBookmarks(true); }
  else if (currentPage === 'hashtag' && hasMoreHashtag) { hashtagPage++; loadHashtagPosts(true); }
}

// ==================== ЛЕНТА ====================
async function loadFeed(append = false) {
  if (isLoadingMore) return;
  isLoadingMore = true;
  document.getElementById('feed-loader').style.display = 'block';
  try {
    const res = await fetch(`${API_URL}/feed?page=${feedPage}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const posts = await res.json();
    const container = document.getElementById('feed-posts');
    if (!append) container.innerHTML = '';
    renderPosts(posts, container);
    hasMoreFeed = posts.length === 10;
    document.getElementById('feed-loader').style.display = 'none';
    
    // Обновляем просмотры на сервере
    posts.forEach(post => {
      fetch(`${API_URL}/posts/${post.id}/view`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }).catch(() => {});
    });
  } catch (err) { console.error(err); }
  isLoadingMore = false;
}

async function loadBookmarks(append = false) {
  if (isLoadingMore) return;
  isLoadingMore = true;
  document.getElementById('bookmarks-loader').style.display = 'block';
  try {
    const res = await fetch(`${API_URL}/bookmarks?page=${bookmarksPage}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const posts = await res.json();
    const container = document.getElementById('bookmarks-posts');
    if (!append) container.innerHTML = '';
    if (posts.length === 0 && !append) container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px;">Нет закладок</p>';
    renderPosts(posts, container);
    hasMoreBookmarks = posts.length === 10;
    document.getElementById('bookmarks-loader').style.display = 'none';
  } catch (err) { console.error(err); }
  isLoadingMore = false;
}

async function loadHashtagPosts(append = false) {
  if (isLoadingMore || !currentHashtag) return;
  isLoadingMore = true;
  document.getElementById('hashtag-loader').style.display = 'block';
  try {
    const res = await fetch(`${API_URL}/hashtags/${currentHashtag}?page=${hashtagPage}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const posts = await res.json();
    const container = document.getElementById('hashtag-posts');
    if (!append) container.innerHTML = '';
    if (posts.length === 0 && !append) container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px;">Нет постов</p>';
    renderPosts(posts, container);
    hasMoreHashtag = posts.length === 10;
    document.getElementById('hashtag-loader').style.display = 'none';
  } catch (err) { console.error(err); }
  isLoadingMore = false;
}

function processContent(content) {
  if (!content) return '';
  return escapeHtml(content).replace(/#([а-яА-Яa-zA-Z0-9_]+)/g, '<span class="hash-tag" onclick="event.stopPropagation();navigateToHashtag(\'$1\')">#$1</span>');
}

function renderPosts(posts, container) {
  posts.forEach(post => {
    const postEl = document.createElement('div');
    postEl.className = 'post-card';
    if (post.is_pinned) postEl.classList.add('pinned');
    postEl.dataset.postId = post.id;
    const date = new Date(post.created_at + 'Z').toLocaleString('ru-RU');
    const isOwner = currentUser && post.author_id === currentUser.id;
    const displayName = post.display_name || post.username;
    const isVideo = post.image_url && /\.(mp4|mov|avi|webm)$/i.test(post.image_url);

    postEl.innerHTML = `
      <div class="post-header">
        <img src="${post.avatar || '/uploads/default-avatar.png'}" class="avatar-small" onclick="navigateTo('profile', ${post.author_id})">
        <div class="post-author-info">
          <span class="post-author-name" onclick="navigateTo('profile', ${post.author_id})">${escapeHtml(displayName)}</span>
          <div class="post-date">
            ${date}${post.edited ? ' <span class="post-edited">(изменено)</span>' : ''}
            ${post.is_pinned ? '<span class="pinned-badge">📌 Закреплено</span>' : ''}
            <span class="post-views">👁 ${post.views || 0}</span>
          </div>
        </div>
        ${isOwner ? `
          <div class="post-menu">
            <button class="post-menu-btn">⋯</button>
            <div class="post-menu-dropdown">
              <button class="post-menu-item pin-btn">${post.is_pinned ? '📌 Открепить' : '📌 Закрепить'}</button>
              <button class="post-menu-item edit-btn">✏️ Редактировать</button>
              <button class="post-menu-item danger delete-btn">🗑 Удалить</button>
            </div>
          </div>` : ''}
      </div>
      ${post.content ? `<div class="post-content">${processContent(post.content)}</div>` : ''}
      ${post.image_url ? (isVideo ? `<video src="${post.image_url}" class="post-video" controls preload="metadata"></video>` : `<img src="${post.image_url}" class="post-image" onclick="this.requestFullscreen?.()">`) : ''}
      <div class="post-actions-bar">
        <button class="like-btn ${post.is_liked ? 'liked' : ''}">${post.is_liked ? '❤️' : '🤍'} <span>${post.likes_count}</span></button>
        <button class="comment-btn">💬 <span>${post.comments_count || 0}</span></button>
        <button class="bookmark-btn ${post.is_bookmarked ? 'bookmarked' : ''}">${post.is_bookmarked ? '🔖' : '🏷'}</button>
      </div>`;

    const menuBtn = postEl.querySelector('.post-menu-btn');
    const menuDropdown = postEl.querySelector('.post-menu-dropdown');
    if (menuBtn && menuDropdown) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.post-menu-dropdown.show').forEach(d => d.classList.remove('show'));
        menuDropdown.classList.toggle('show');
      });
      postEl.querySelector('.pin-btn').addEventListener('click', (e) => { e.stopPropagation(); menuDropdown.classList.remove('show'); pinPost(post.id); });
      postEl.querySelector('.edit-btn').addEventListener('click', (e) => { e.stopPropagation(); menuDropdown.classList.remove('show'); openEditPost(post.id); });
      postEl.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); menuDropdown.classList.remove('show'); deletePost(post.id); });
    }
    postEl.querySelector('.like-btn').addEventListener('click', () => toggleLike(post.id, postEl.querySelector('.like-btn')));
    postEl.querySelector('.comment-btn').addEventListener('click', () => openComments(post.id));
    postEl.querySelector('.bookmark-btn').addEventListener('click', () => toggleBookmark(post.id, postEl.querySelector('.bookmark-btn')));
    
    container.appendChild(postEl);
  });
}

async function createPost(e) {
  e.preventDefault();
  const content = document.getElementById('post-content').value;
  const imageFile = document.getElementById('post-image').files[0];
  if (!content && !imageFile) return;
  const formData = new FormData();
  formData.append('content', content);
  if (imageFile) formData.append('image', imageFile);
  try {
    const res = await fetch(API_URL + '/posts', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: formData });
    if (res.ok) {
      document.getElementById('post-content').value = '';
      document.getElementById('post-image').value = '';
      document.getElementById('image-preview').style.display = 'none';
      document.getElementById('video-preview').style.display = 'none';
      feedPage = 1; hasMoreFeed = true; document.getElementById('feed-posts').innerHTML = ''; loadFeed();
    }
  } catch (err) { console.error(err); }
}

async function toggleLike(postId, button) {
  try {
    const res = await fetch(`${API_URL}/posts/${postId}/like`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    const span = button.querySelector('span');
    let count = parseInt(span.textContent);
    if (data.liked) { button.classList.add('liked'); button.innerHTML = '❤️ <span>' + (count + 1) + '</span>'; }
    else { button.classList.remove('liked'); button.innerHTML = '🤍 <span>' + (count - 1) + '</span>'; }
  } catch (err) { console.error(err); }
}

async function toggleBookmark(postId, button) {
  try {
    const res = await fetch(`${API_URL}/posts/${postId}/bookmark`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (data.bookmarked) { button.classList.add('bookmarked'); button.textContent = '🔖'; }
    else { button.classList.remove('bookmarked'); button.textContent = '🏷'; }
  } catch (err) { console.error(err); }
}

async function pinPost(postId) {
  try {
    const res = await fetch(`${API_URL}/posts/${postId}/pin`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) {
      document.querySelectorAll('.post-menu-dropdown.show').forEach(d => d.classList.remove('show'));
      refreshCurrentView();
    }
  } catch (err) { console.error(err); }
}

function openEditPost(postId) { currentPostForEdit = postId; document.getElementById('edit-post-modal').style.display = 'flex'; document.getElementById('delete-post-btn').onclick = () => deletePost(postId); }
function closeEditPost() { document.getElementById('edit-post-modal').style.display = 'none'; currentPostForEdit = null; }

async function saveEditPost() {
  if (!currentPostForEdit) return;
  const content = document.getElementById('edit-post-content').value;
  const imageFile = document.getElementById('edit-post-image').files[0];
  const formData = new FormData(); formData.append('content', content); formData.append('keep_image', 'true');
  if (imageFile) formData.append('image', imageFile);
  try {
    const res = await fetch(`${API_URL}/posts/${currentPostForEdit}`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}` }, body: formData });
    if (res.ok) { closeEditPost(); refreshCurrentView(); }
  } catch (err) { console.error(err); }
}

async function deletePost(postId) {
  if (!confirm('Удалить пост?')) return;
  try { await fetch(`${API_URL}/posts/${postId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }); closeEditPost(); refreshCurrentView(); }
  catch (err) { console.error(err); }
}

function refreshCurrentView() {
  if (currentPage === 'feed') { feedPage = 1; hasMoreFeed = true; document.getElementById('feed-posts').innerHTML = ''; loadFeed(); }
  else if (currentPage === 'profile') { document.getElementById('profile-posts').innerHTML = ''; loadProfile(currentProfileId); }
  else if (currentPage === 'bookmarks') { bookmarksPage = 1; hasMoreBookmarks = true; document.getElementById('bookmarks-posts').innerHTML = ''; loadBookmarks(); }
}

// ==================== КОММЕНТАРИИ ====================
async function openComments(postId) { currentPostForComments = postId; document.getElementById('comments-modal').style.display = 'flex'; document.getElementById('comment-input').value = ''; document.getElementById('comment-input').focus(); await loadComments(postId); }
function closeComments() { document.getElementById('comments-modal').style.display = 'none'; currentPostForComments = null; }

async function loadComments(postId) {
  try {
    const res = await fetch(`${API_URL}/posts/${postId}/comments`, { headers: { 'Authorization': `Bearer ${token}` } });
    const comments = await res.json();
    const list = document.getElementById('comments-list');
    if (comments.length === 0) { list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">Пока нет комментариев</p>'; return; }
    list.innerHTML = comments.map(c => {
      const d = new Date(c.created_at + 'Z').toLocaleString('ru-RU');
      const isOwner = c.author_id === currentUser.id;
      return `<div class="comment-item">
        <img src="${c.avatar || '/uploads/default-avatar.png'}" class="comment-avatar" onclick="navigateTo('profile',${c.author_id});closeComments();">
        <div class="comment-body" onclick="navigateTo('profile',${c.author_id});closeComments();">
          <span class="comment-author">${escapeHtml(c.display_name || c.username)}</span>
          <div class="comment-text">${escapeHtml(c.content)}</div>
          <div class="comment-date">${d} ${isOwner ? '· <a href="#" onclick="event.stopPropagation();deleteComment('+c.id+');return false;" style="color:var(--danger);">удалить</a>' : ''}</div>
        </div></div>`;
    }).join('');
  } catch (err) { console.error(err); }
}

async function addComment(e) {
  e.preventDefault();
  const content = document.getElementById('comment-input').value.trim();
  if (!content || !currentPostForComments) return;
  try {
    const res = await fetch(`${API_URL}/posts/${currentPostForComments}/comments`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content })
    });
    if (res.ok) { document.getElementById('comment-input').value = ''; await loadComments(currentPostForComments); refreshCurrentView(); }
  } catch (err) { console.error(err); }
}

async function deleteComment(commentId) {
  if (!confirm('Удалить комментарий?')) return;
  try { await fetch(`${API_URL}/comments/${commentId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }); await loadComments(currentPostForComments); refreshCurrentView(); }
  catch (err) { console.error(err); }
}

// ==================== ПРОФИЛЬ ====================
async function loadProfile(userId) {
  try {
    const res = await fetch(`${API_URL}/users/${userId}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('Не найден');
    const user = await res.json();
    currentProfileId = user.id;

    document.getElementById('profile-avatar').src = user.avatar || '/uploads/default-avatar.png';
    document.getElementById('profile-display-name').textContent = user.display_name || user.username;
    document.getElementById('profile-username-display').textContent = '@' + user.username;
    document.getElementById('profile-bio').textContent = user.bio || '';
    document.getElementById('profile-posts-count').textContent = user.posts_count;
    document.getElementById('profile-followers-count').textContent = user.followers_count;
    document.getElementById('profile-following-count').textContent = user.following_count;
    document.getElementById('profile-private-badge').style.display = user.is_private ? 'inline' : 'none';

    document.getElementById('profile-followers-count').parentElement.onclick = () => openFollowsModal(user.id, 'followers');
    document.getElementById('profile-following-count').parentElement.onclick = () => openFollowsModal(user.id, 'following');

    const avatarUploadLabel = document.getElementById('avatar-upload-label');
    if (user.id === currentUser.id) {
      avatarUploadLabel.style.display = 'flex';
      avatarUploadLabel.onclick = function(e) {
        e.preventDefault(); e.stopPropagation();
        const fileInput = document.createElement('input');
        fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.style.display = 'none';
        fileInput.onchange = async function() {
          const file = fileInput.files[0];
          if (!file) return;
          if (!file.type.startsWith('image/')) { alert('Выберите изображение'); return; }
          const formData = new FormData(); formData.append('avatar', file);
          try {
            const uploadRes = await fetch(`${API_URL}/profile`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}` }, body: formData });
            if (uploadRes.ok) {
              const updatedUser = await uploadRes.json(); currentUser = updatedUser;
              document.getElementById('current-user-avatar').src = updatedUser.avatar || '/uploads/default-avatar.png';
              document.getElementById('profile-avatar').src = updatedUser.avatar || '/uploads/default-avatar.png';
            }
          } catch (err) { alert('Ошибка соединения'); }
          document.body.removeChild(fileInput);
        };
        document.body.appendChild(fileInput); fileInput.click();
      };
    } else { avatarUploadLabel.style.display = 'none'; avatarUploadLabel.onclick = null; }

    const actionsDiv = document.getElementById('profile-actions');
    if (user.id === currentUser.id) {
      actionsDiv.innerHTML = '<button class="btn-follow" id="edit-profile-toggle-btn" style="background:var(--bg-input);color:var(--text);">✏️ Редактировать профиль</button>';
      if (user.is_private) {
        actionsDiv.innerHTML += ' <button class="btn-sm" onclick="openRequestsModal()" style="background:#f39c12;">📋 Заявки</button>';
      }
      document.getElementById('edit-profile-section').style.display = 'none';
      document.getElementById('edit-username').value = user.username;
      document.getElementById('edit-display-name').value = user.display_name || '';
      document.getElementById('edit-bio').value = user.bio || '';
      document.getElementById('edit-private').checked = user.is_private;
      document.getElementById('edit-profile-toggle-btn').onclick = function() {
        const editSection = document.getElementById('edit-profile-section');
        if (editSection.style.display === 'none') { editSection.style.display = 'block'; this.textContent = '✏️ Закрыть'; }
        else { editSection.style.display = 'none'; this.textContent = '✏️ Редактировать профиль'; }
      };
    } else {
      document.getElementById('edit-profile-section').style.display = 'none';
      let followBtn = '';
      if (user.is_following) followBtn = `<button class="btn-follow following" onclick="toggleFollow(${user.id}, this)">Отписаться</button>`;
      else if (user.has_requested) followBtn = `<button class="btn-follow requested" onclick="toggleFollow(${user.id}, this)">Заявка отправлена</button>`;
      else followBtn = `<button class="btn-follow" onclick="toggleFollow(${user.id}, this)">Подписаться</button>`;
      actionsDiv.innerHTML = followBtn + ` <button class="btn-sm" onclick="navigateTo('messages');openChat(${user.id},'${escapeHtml(user.display_name || user.username)}','${user.avatar || '/uploads/default-avatar.png'}')">💬 Сообщение</button>`;
    }

    // Загружаем посты
    const postsRes = await fetch(`${API_URL}/posts/user/${userId}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const postsData = await postsRes.json();
    const container = document.getElementById('profile-posts');
    const privateMsg = document.getElementById('profile-private-message');
    container.innerHTML = '';
    
    if (postsData.private) {
      privateMsg.style.display = 'block';
      container.innerHTML = '';
    } else {
      privateMsg.style.display = 'none';
      renderPosts(postsData, container);
    }
  } catch (err) { console.error(err); }
}

async function toggleFollow(userId, button) {
  try {
    const res = await fetch(`${API_URL}/users/${userId}/follow`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (data.following) { button.textContent = 'Отписаться'; button.className = 'btn-follow following'; }
    else if (data.requested) { button.textContent = 'Заявка отправлена'; button.className = 'btn-follow requested'; }
    else { button.textContent = 'Подписаться'; button.className = 'btn-follow'; }
    loadProfile(userId);
  } catch (err) { console.error(err); }
}

async function saveUsername() {
  const username = document.getElementById('edit-username').value.trim();
  const errorEl = document.getElementById('username-error');
  errorEl.textContent = '';
  if (!username || username.length < 3) { errorEl.textContent = 'Минимум 3 символа'; return; }
  try {
    const res = await fetch(`${API_URL}/profile/username`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
    const data = await res.json();
    if (res.ok) {
      token = data.token; localStorage.setItem('token', token); currentUser = data.user;
      document.getElementById('edit-profile-section').style.display = 'none';
      const toggleBtn = document.getElementById('edit-profile-toggle-btn');
      if (toggleBtn) toggleBtn.textContent = '✏️ Редактировать профиль';
      loadProfile(currentUser.id);
    } else { errorEl.textContent = data.error; }
  } catch (err) { errorEl.textContent = 'Ошибка'; }
}

async function saveProfile() {
  const display_name = document.getElementById('edit-display-name').value.trim();
  const bio = document.getElementById('edit-bio').value.trim();
  const is_private = document.getElementById('edit-private').checked;
  try {
    const res = await fetch(`${API_URL}/profile`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ display_name, bio, is_private }) });
    if (res.ok) {
      const user = await res.json(); currentUser = user;
      document.getElementById('edit-profile-section').style.display = 'none';
      const toggleBtn = document.getElementById('edit-profile-toggle-btn');
      if (toggleBtn) toggleBtn.textContent = '✏️ Редактировать профиль';
      loadProfile(currentUser.id);
    }
  } catch (err) { console.error(err); }
}

// ==================== ЗАЯВКИ ====================
async function openRequestsModal() {
  document.getElementById('requests-modal').style.display = 'flex';
  try {
    const res = await fetch(`${API_URL}/follow-requests`, { headers: { 'Authorization': `Bearer ${token}` } });
    const requests = await res.json();
    const list = document.getElementById('requests-list');
    if (requests.length === 0) { list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">Нет заявок</p>'; return; }
    list.innerHTML = requests.map(r => `
      <div class="comment-item" style="align-items:center;">
        <img src="${r.avatar || '/uploads/default-avatar.png'}" class="comment-avatar" onclick="navigateTo('profile',${r.follower_id});closeRequestsModal();">
        <div class="comment-body" onclick="navigateTo('profile',${r.follower_id});closeRequestsModal();">
          <span class="comment-author">${escapeHtml(r.display_name || r.username)}</span>
          <div style="font-size:12px;color:var(--text-muted);">@${escapeHtml(r.username)}</div>
        </div>
        <button class="btn-sm" onclick="event.stopPropagation();handleRequest(${r.id},'accept')">✓</button>
        <button class="btn-sm" style="background:var(--danger);" onclick="event.stopPropagation();handleRequest(${r.id},'reject')">✕</button>
      </div>`).join('');
  } catch (err) { console.error(err); }
}
function closeRequestsModal() { document.getElementById('requests-modal').style.display = 'none'; }

async function handleRequest(requestId, action) {
  try {
    await fetch(`${API_URL}/follow-requests/${requestId}/${action}`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    openRequestsModal();
    loadProfile(currentUser.id);
  } catch (err) { console.error(err); }
}

// ==================== ПОДПИСКИ МОДАЛКА ====================
async function openFollowsModal(userId, type) {
  document.getElementById('follows-modal').style.display = 'flex';
  document.getElementById('follows-modal-title').textContent = type === 'followers' ? 'Подписчики' : 'Подписки';
  try {
    const res = await fetch(`${API_URL}/users/${userId}/${type}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const users = await res.json();
    const list = document.getElementById('follows-list');
    if (users.length === 0) { list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">Никого нет</p>'; return; }
    list.innerHTML = users.map(u => `
      <div class="comment-item" style="align-items:center;">
        <img src="${u.avatar || '/uploads/default-avatar.png'}" class="comment-avatar" onclick="navigateTo('profile',${u.id});closeFollowsModal();">
        <div class="comment-body" onclick="navigateTo('profile',${u.id});closeFollowsModal();">
          <span class="comment-author">${escapeHtml(u.display_name || u.username)}</span>
          <div style="font-size:12px;color:var(--text-muted);">@${escapeHtml(u.username)}</div>
        </div>
        ${u.id !== currentUser.id ? `<button class="btn-sm" onclick="event.stopPropagation();quickFollowInModal(${u.id}, this)" style="${u.is_following ? 'background:var(--bg-input);color:var(--text);' : ''}">${u.is_following ? 'Отписаться' : 'Подписаться'}</button>` : ''}
      </div>`).join('');
  } catch (err) { console.error(err); }
}
function closeFollowsModal() { document.getElementById('follows-modal').style.display = 'none'; }

async function quickFollowInModal(userId, button) {
  try {
    const res = await fetch(`${API_URL}/users/${userId}/follow`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (data.following) { button.textContent = 'Отписаться'; button.style.background = 'var(--bg-input)'; button.style.color = 'var(--text)'; }
    else if (data.requested) { button.textContent = 'Заявка'; button.style.background = '#f39c12'; button.style.color = 'white'; }
    else { button.textContent = 'Подписаться'; button.style.background = 'var(--primary)'; button.style.color = 'white'; }
  } catch (err) { console.error(err); }
}

// ==================== СООБЩЕНИЯ ====================
async function loadChats() {
  try {
    const res = await fetch(`${API_URL}/messages/chats`, { headers: { 'Authorization': `Bearer ${token}` } });
    const chats = await res.json();
    const container = document.getElementById('chats-container');
    if (chats.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">Нет сообщений</p>';
      return;
    }
    container.innerHTML = chats.map(c => {
      const d = c.last_time ? new Date(c.last_time + 'Z').toLocaleString('ru-RU') : '';
      return `<div class="chat-item${currentChatUserId === c.id ? ' active' : ''}" onclick="openChat(${c.id},'${escapeHtml(c.display_name || c.username)}','${c.avatar || '/uploads/default-avatar.png'}')">
        <img src="${c.avatar || '/uploads/default-avatar.png'}" class="avatar-small">
        <div class="chat-item-info">
          <div class="chat-item-name">${escapeHtml(c.display_name || c.username)}</div>
          <div class="chat-item-last">${escapeHtml(c.last_message || '')}</div>
        </div>
        ${c.unread > 0 ? `<span class="chat-item-unread">${c.unread}</span>` : ''}
        <div style="font-size:10px;color:var(--text-muted);">${d}</div>
      </div>`;
    }).join('');
  } catch (err) { console.error(err); }
}

function openChat(userId, name, avatar) {
  currentChatUserId = userId;
  document.getElementById('chat-messages').style.display = 'flex';
  document.getElementById('chat-input-form').style.display = 'flex';
  document.querySelector('.chat-placeholder').style.display = 'none';
  document.getElementById('chat-input').focus();
  loadMessages();
  // Обновляем список чатов
  loadChats();
}

async function loadMessages() {
  if (!currentChatUserId) return;
  try {
    const res = await fetch(`${API_URL}/messages/${currentChatUserId}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const messages = await res.json();
    const container = document.getElementById('chat-messages');
    container.innerHTML = messages.map(m => {
      const d = new Date(m.created_at + 'Z').toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      return `<div class="message-row ${m.from_user_id === currentUser.id ? 'own' : ''}">
        <img src="${m.avatar || '/uploads/default-avatar.png'}" class="message-avatar" onclick="navigateTo('profile',${m.from_user_id})">
        <div>
          <div class="message-bubble">${escapeHtml(m.content)}</div>
          <div class="message-time">${d}</div>
        </div>
      </div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
  } catch (err) { console.error(err); }
}

async function sendMessage(e) {
  e.preventDefault();
  const content = document.getElementById('chat-input').value.trim();
  if (!content || !currentChatUserId) return;
  try {
    const res = await fetch(`${API_URL}/messages/${currentChatUserId}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (res.ok) {
      document.getElementById('chat-input').value = '';
      loadMessages();
      loadChats();
    }
  } catch (err) { console.error(err); }
}

// ==================== УВЕДОМЛЕНИЯ ====================
async function loadUnreadCount() {
  try {
    const res = await fetch(`${API_URL}/notifications/unread-count`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    unreadCount = data.count;
    const badge = document.getElementById('notifications-badge');
    if (unreadCount > 0) { badge.style.display = 'flex'; badge.textContent = unreadCount > 99 ? '99+' : unreadCount; }
    else { badge.style.display = 'none'; }
  } catch (err) {}
}

async function toggleNotifications() {
  const dropdown = document.getElementById('notifications-dropdown');
  if (notificationsOpen) { dropdown.classList.remove('show'); notificationsOpen = false; }
  else {
    await loadNotifications();
    dropdown.classList.add('show'); notificationsOpen = true;
    if (unreadCount > 0) {
      await fetch(`${API_URL}/notifications/read-all`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
      loadUnreadCount();
    }
  }
}

async function loadNotifications() {
  try {
    const res = await fetch(`${API_URL}/notifications`, { headers: { 'Authorization': `Bearer ${token}` } });
    const notifications = await res.json();
    const dropdown = document.getElementById('notifications-dropdown');
    if (notifications.length === 0) { dropdown.innerHTML = '<div class="notifications-empty">Нет уведомлений</div>'; return; }
    dropdown.innerHTML = notifications.map(n => {
      const d = new Date(n.created_at + 'Z').toLocaleString('ru-RU');
      let text = '';
      if (n.type === 'like') text = `<b>${escapeHtml(n.display_name || n.username)}</b> поставил(а) ❤️`;
      else if (n.type === 'comment') text = `<b>${escapeHtml(n.display_name || n.username)}</b> прокомментировал(а)`;
      else if (n.type === 'follow') text = `<b>${escapeHtml(n.display_name || n.username)}</b> подписался(ась)`;
      else if (n.type === 'follow_request') text = `<b>${escapeHtml(n.display_name || n.username)}</b> хочет подписаться`;
      else if (n.type === 'follow_accept') text = `<b>${escapeHtml(n.display_name || n.username)}</b> принял(а) заявку`;
      else if (n.type === 'message') text = `<b>${escapeHtml(n.display_name || n.username)}</b> прислал(а) сообщение`;
      return `<div class="notification-item ${n.read ? '' : 'unread'}" onclick="handleNotificationClick('${n.type}', ${n.from_user_id});">
        <img src="${n.avatar || '/uploads/default-avatar.png'}" class="avatar-small">
        <div class="notification-text">${text}</div>
        <div class="notification-time">${d}</div>
      </div>`;
    }).join('');
  } catch (err) { console.error(err); }
}

function handleNotificationClick(type, fromUserId) {
  document.getElementById('notifications-dropdown').classList.remove('show');
  notificationsOpen = false;
  if (type === 'message') { navigateTo('messages'); openChat(fromUserId, '', ''); }
  else { navigateTo('profile', fromUserId); }
}

// ==================== ПОИСК ====================
async function showSuggestedInSearch() {
  try {
    const res = await fetch(`${API_URL}/users/suggested`, { headers: { 'Authorization': `Bearer ${token}` } });
    const users = await res.json();
    const dropdown = document.getElementById('search-results');
    if (!users || users.length === 0) { dropdown.innerHTML = '<div class="search-item" style="color:var(--text-muted)">Никого нет</div>'; return; }
    dropdown.innerHTML = '<div class="search-hint">Предлагаемые</div>' + users.map(u => `
      <div class="search-item" onclick="navigateTo('profile',${u.id});document.getElementById('search-input').value='';document.getElementById('search-results').innerHTML='';">
        <img src="${u.avatar || '/uploads/default-avatar.png'}" class="avatar-small">
        <div><div style="font-weight:600;">${escapeHtml(u.display_name || u.username)}${u.is_private ? ' 🔒' : ''}</div><div style="font-size:12px;color:var(--text-muted);">@${escapeHtml(u.username)}</div></div>
      </div>`).join('');
  } catch (err) { console.error(err); }
}

async function searchUsers(query) {
  try {
    const res = await fetch(`${API_URL}/users/search?q=${encodeURIComponent(query)}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const users = await res.json();
    const dropdown = document.getElementById('search-results');
    if (users.length === 0) { dropdown.innerHTML = '<div class="search-item" style="color:var(--text-muted)">Ничего не найдено</div>'; return; }
    dropdown.innerHTML = users.map(u => `
      <div class="search-item" onclick="navigateTo('profile',${u.id});document.getElementById('search-input').value='';document.getElementById('search-results').innerHTML='';">
        <img src="${u.avatar || '/uploads/default-avatar.png'}" class="avatar-small">
        <div><div style="font-weight:600;">${escapeHtml(u.display_name || u.username)}${u.is_private ? ' 🔒' : ''}</div><div style="font-size:12px;color:var(--text-muted);">@${escapeHtml(u.username)}</div></div>
      </div>`).join('');
  } catch (err) { console.error(err); }
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ====================
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function previewMedia(e) {
  const file = e.target.files[0];
  if (!file) { document.getElementById('image-preview').style.display = 'none'; document.getElementById('video-preview').style.display = 'none'; return; }
  const reader = new FileReader();
  reader.onload = (ev) => {
    if (file.type.startsWith('video/')) {
      document.getElementById('video-preview').src = ev.target.result;
      document.getElementById('video-preview').style.display = 'block';
      document.getElementById('image-preview').style.display = 'none';
    } else {
      document.getElementById('image-preview').src = ev.target.result;
      document.getElementById('image-preview').style.display = 'block';
      document.getElementById('video-preview').style.display = 'none';
    }
  };
  reader.readAsDataURL(file);
}