(async () => {
  const el = document.getElementById('status');
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const s = settings || {};
    el.textContent = `Currently ${s.enabled ? 'ON' : 'off'} · vocals ${Math.round((s.vocalLevel ?? 0) * 100)}% · transpose ${s.semitones > 0 ? '+' : ''}${s.semitones ?? 0} · model ${s.modelId || 'default'} · quality ${s.quality || 'high'}`;
  } catch (e) { el.textContent = ''; }
})();
