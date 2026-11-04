// ヘルプ（使い方・FAQ）ダイアログの開閉。各画面で共通。
// [data-help-open] のボタンで開き、「閉じる」・背景タップ・Esc で閉じる。
(() => {
  const dialog = document.getElementById('help-dialog');
  if (!dialog) return;

  // 入ってきた道を戻るアニメーションのあとで close() する
  function closeHelp() {
    if (!dialog.open || dialog.classList.contains('closing')) return;
    dialog.classList.add('closing');
    const done = () => { dialog.classList.remove('closing'); dialog.close(); };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; }
    dialog.addEventListener('animationend', done, { once: true });
  }

  document.querySelectorAll('[data-help-open]').forEach(b => {
    b.addEventListener('click', () => {
      if (dialog.open) return;
      dialog.showModal();
      dialog.scrollTop = 0;
    });
  });
  dialog.querySelector('.help-close').addEventListener('click', closeHelp);
  // 枠の外（背景）をタップしたら閉じる
  // （ダイアログ自身の余白をタップしたときは閉じない）
  dialog.addEventListener('click', e => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) closeHelp();
  });
  dialog.addEventListener('cancel', e => { e.preventDefault(); closeHelp(); });
})();
