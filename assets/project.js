document.querySelectorAll('[data-gif]').forEach(function (button) {
  const image = document.getElementById(button.getAttribute('aria-controls'));
  const poster = image.getAttribute('src');
  const gif = button.dataset.gif;

  function setPlaying(playing) {
    image.src = playing ? gif : poster;
    button.textContent = playing ? 'Stop' : 'Play';
    button.setAttribute('aria-label', button.textContent + ' ' + image.alt + ' animation');
  }

  button.addEventListener('click', function () {
    setPlaying(image.getAttribute('src') === poster);
  });
  image.addEventListener('error', function () {
    if (image.getAttribute('src') === gif) setPlaying(false);
  });
  setPlaying(true);
});
