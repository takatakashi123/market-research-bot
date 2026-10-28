// src/components/NewsList.js
import React from 'react';
import newsData from '../data/newsData';
import '../styles/NewsList.css';

function NewsList() {
  return (
    <div className="news-container">
      <div className="news-header">
        <h2>ニュースリリース</h2>
        <a href="/news" className="news-link">一覧を見る &gt;</a>
      </div>
      <ul className="news-list">
        {newsData.map((news, index) => (
          <li key={index} className="news-item">
            <p className="news-date">{news.date}</p>
            <p className="news-company">{news.company}</p>
            <h3 className="news-title">{news.title}</h3>
            {news.content && <p className="news-content">{news.content}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default NewsList;
