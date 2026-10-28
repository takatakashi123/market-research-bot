import React, { useState } from 'react';
import './Slider.css';

const images = [
  { src: 'image1.jpg', title: 'Image 1', description: 'Description for Image 1' },
  { src: 'image2.jpg', title: 'Image 2', description: 'Description for Image 2' },
  { src: 'image3.jpg', title: 'Image 3', description: 'Description for Image 3' }
];

function Slider() {
  const [currentIndex, setCurrentIndex] = useState(0);

  const nextSlide = () => {
    setCurrentIndex((currentIndex + 1) % images.length);
  };

  const prevSlide = () => {
    setCurrentIndex((currentIndex - 1 + images.length) % images.length);
  };

  return (
    <div className="slider">
      <div className="slider-content">
        <img src={images[currentIndex].src} alt={images[currentIndex].title} />
        <h3>{images[currentIndex].title}</h3>
        <p>{images[currentIndex].description}</p>
      </div>
      <button className="slider-button slider-button-left" onClick={prevSlide}>&lt;</button>
      <button className="slider-button slider-button-right" onClick={nextSlide}>&gt;</button>
    </div>
  );
}

export default Slider;
