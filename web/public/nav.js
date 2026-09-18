(function () {
  const input = document.getElementById('nav-open');
  if (!input) return;

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') input.checked = false;
  });
})();
