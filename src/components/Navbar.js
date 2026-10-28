import React from 'react';
import { Link } from 'react-router-dom';
import '../styles/Navbar.css';

function Navbar() {
  return (
    <nav className="navbar">
      <div className="navbar-logo">スパイス魂</div>
      <ul className="navbar-links">
        <li><Link to="/">ホーム</Link></li>
        <li><Link to="/about">会社情報</Link></li>
        <li><Link to="/contact">ニュースリリース</Link></li>
        <li><Link to="/login">ログイン</Link></li>
      </ul>
      <div className="navbar-lang" style={{ marginRight: "50px" }}> English / Japanese</div>
    </nav>
  );
}

export default Navbar;
