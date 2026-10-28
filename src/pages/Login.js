// src/pages/Login.js
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../styles/Login.css'; // ログインページ専用のスタイルをインポート

function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const navigate = useNavigate(); // React Routerのフックを使用してナビゲート

  const handleSubmit = (event) => {
    event.preventDefault();
    if (username === 'a' && password === 'a') {
      setMessage('ログイン成功');
      setTimeout(() => navigate('/'), 1000); // 1秒後にホームにリダイレクト
    } else {
      setMessage('ユーザー名またはパスワードが間違っています');
    }
  };

  return (
    <div className="login-container">
      <h2>ログイン画面</h2>
      <form onSubmit={handleSubmit}>
        <label>
          ユーザー名:
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label>
          パスワード:
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button type="submit">ログイン</button>
      </form>
      {message && <p>{message}</p>}
    </div>
  );
}

export default Login;
