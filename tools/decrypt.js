/* globals document, URL, Blob, DFEncExport */
(() => {
  const form = document.getElementById('form');
  const file = document.getElementById('file');
  const pass = document.getElementById('pass');
  const error = document.getElementById('error');
  const result = document.getElementById('result');

  const say = (el, text) => {
    el.textContent = text;
    el.hidden = false;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    result.hidden = true;
    result.replaceChildren();
    const f = file.files[0];
    if (!f) return say(error, 'Choose the encrypted file first.');
    try {
      const plain = await DFEncExport.decrypt(await f.text(), pass.value);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([plain], { type: 'application/zip' }));
      link.download = DFEncExport.plainName(f.name);
      link.textContent = 'Save ' + link.download;
      result.replaceChildren(link);
      result.hidden = false;
    } catch (err) {
      say(error, err.message);
    } finally {
      pass.value = '';
    }
  });
})();
