/* SONIX Stremio Addons + Online Subtitle Search.
 * Runs in the existing WebView and delegates network/file/player operations to Android.
 */
(function () {
  'use strict';
  const STORAGE_KEY = 'sonix_stremio_addons_v1';
  const STYLE_KEY = 'sonix_subtitle_style_v1';
  const DEFAULT_ADDONS = [
    { id:'com.linvo.cinemeta', name:'Cinemeta', version:'3.0.14',
      description:'The official addon for movie and series catalogs',
      url:'https://v3-cinemeta.strem.io/manifest.json',
      types:['movie','series'], resources:['catalog','meta','addon_catalog'], enabled:true },
    { id:'org.stremio.opensubtitlesv3', name:'OpenSubtitles V3', version:'1.0.0',
      description:'Official OpenSubtitles v3',
      url:'https://opensubtitles-v3.strem.io/manifest.json',
      types:['movie','series'], resources:['subtitles'], enabled:true },
    { id:'opensubtitles-pro', name:'OpenSubtitles PRO', version:'0.1.0',
      description:'Community subtitle addon',
      url:'https://opensubtitlesv3-pro.dexter21767.com/manifest.json',
      types:['movie','series'], resources:['subtitles'], enabled:true }
  ];
  const LANGUAGES = [
    {label:'Hindi',code:'hi'},{label:'Urdu',code:'ur'},
    {label:'Arabic',code:'ar'},{label:'English',code:'en'},
    {label:'All',code:'all'}
  ];
  const FONTS = ['Reem Kufi','Aref Ruqaa','Lalezar','Amiri','Rakkas','Marhey','Noto Naskh','Changa','Noto Kufi','Lemonada'];
  let installed = [];
  let market = {official:[], community:[]};
  let activeTab = 'installed';
  let searchText = '';
  let subtitleResults = [];
  let subtitleBusy = false;
  let subtitleLanguage = 'ar';
  let currentSubtitleLabel = '';
  let subtitleStyle = readStyle();

  function readStyle() {
    try {
      return Object.assign({font:'Reem Kufi',size:24,color:'#FFFFFF',background:'off',outline:'shadow',position:'bottom'},
        JSON.parse(localStorage.getItem(STYLE_KEY) || '{}'));
    } catch (_) {
      return {font:'Reem Kufi',size:24,color:'#FFFFFF',background:'off',outline:'shadow',position:'bottom'};
    }
  }
  function saveStyle() {
    try { localStorage.setItem(STYLE_KEY, JSON.stringify(subtitleStyle)); } catch (_) {}
    applyStyle();
  }
  function nativeText(url) {
    if (!window.NativePlayback || !window.NativePlayback.fetchText) throw new Error('خدمة الاتصال غير متاحة');
    const raw = window.NativePlayback.fetchText(String(url));
    const value = JSON.parse(raw || '{}');
    if (!value.success) throw new Error(value.error || 'تعذر تحميل البيانات');
    return value.body || '';
  }
  function parseList(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    for (const key of ['addons','data','results','items']) if (Array.isArray(value[key])) return value[key];
    return [];
  }
  function normalizeAddon(raw, source) {
    if (!raw || typeof raw !== 'object') return null;
    const manifest = raw.manifest || raw;
    const url = String(raw.url || raw.manifestUrl || raw.transportUrl || raw.manifest_url ||
      (raw.transport && raw.transport.url) || '').trim();
    const name = String(raw.name || manifest.name || raw.title || '').trim();
    if (!url || !name || !/^https?:\/\//i.test(url)) return null;
    const resources = Array.isArray(manifest.resources) ? manifest.resources.map(x => typeof x === 'string' ? x : x && x.name || '') : [];
    const types = Array.isArray(manifest.types) ? manifest.types : ['movie','series'];
    return {
      id:String(raw.id || manifest.id || url), name,
      version:String(raw.version || manifest.version || ''),
      description:String(raw.description || manifest.description || ''),
      url:url.endsWith('/manifest.json') ? url : url.replace(/\/+$/,'') + '/manifest.json',
      types, resources, enabled:raw.enabled !== false,
      source:source || raw.source || 'community',
      configurationRequired:raw.configurationRequired === true || url.includes('[config]'),
      configureUrl:raw.configureUrl || ''
    };
  }
  function ensureDefaults(list) {
    const result = Array.isArray(list) ? list.slice() : [];
    DEFAULT_ADDONS.forEach(seed => {
      const index = result.findIndex(x => x && (x.id === seed.id || x.url === seed.url));
      if (index < 0) result.push({...seed});
      else result[index] = {...seed, ...result[index], id:seed.id, name:seed.name, version:seed.version, url:seed.url,
        resources:seed.resources, types:seed.types, enabled:result[index].enabled !== false};
    });
    return result;
  }
  function saveInstalled() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(installed)); } catch (_) {}
  }
  function loadInstalled() {
    try { installed = ensureDefaults(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); }
    catch (_) { installed = ensureDefaults([]); }
    saveInstalled();
  }
  function isInstalled(addon) {
    return installed.some(x => x.id === addon.id || x.url === addon.url);
  }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function renderAddons() {
    const host = document.getElementById('addons-list');
    if (!host) return;
    const source = activeTab === 'installed' ? installed : market[activeTab] || [];
    const q = searchText.trim().toLowerCase();
    const visible = source.filter(x => !q || (x.name+' '+x.description+' '+x.id).toLowerCase().includes(q));
    host.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'addon-empty';
      empty.textContent = activeTab === 'installed' ? 'لا توجد إضافات مطابقة' : 'لا توجد نتائج. جرّب البحث بكلمات أخرى.';
      host.appendChild(empty);
      return;
    }
    visible.forEach(addon => {
      const row = document.createElement('article');
      row.className = 'addon-card';
      const meta = document.createElement('div');
      meta.className = 'addon-card-meta';
      const title = document.createElement('strong');
      title.textContent = addon.name;
      const version = document.createElement('small');
      version.textContent = addon.version ? 'v' + addon.version : 'إضافة';
      const description = document.createElement('p');
      description.textContent = addon.description || 'لا يوجد وصف متاح';
      const resources = document.createElement('small');
      resources.textContent = (addon.resources || []).join(', ');
      meta.append(title,version,description,resources);
      const actions = document.createElement('div');
      actions.className = 'addon-card-actions';
      if (activeTab === 'installed') {
        const toggle = document.createElement('button');
        toggle.className = 'action-btn focusable settings-action-secondary';
        toggle.textContent = addon.enabled === false ? 'تفعيل' : 'تعطيل';
        toggle.addEventListener('click', () => {
          addon.enabled = addon.enabled === false;
          saveInstalled(); renderAddons();
        });
        actions.appendChild(toggle);
        if (!DEFAULT_ADDONS.some(x => x.id === addon.id)) {
          const remove = document.createElement('button');
          remove.className = 'action-btn focusable addon-remove';
          remove.textContent = 'إزالة';
          remove.addEventListener('click', () => {
            installed = installed.filter(x => x.id !== addon.id);
            saveInstalled(); renderAddons();
          });
          actions.appendChild(remove);
        }
      } else {
        const button = document.createElement('button');
        button.className = 'action-btn focusable settings-action-primary';
        button.textContent = isInstalled(addon) ? 'مثبتة' : 'تثبيت';
        button.disabled = isInstalled(addon);
        button.addEventListener('click', () => installAddon(addon, button));
        actions.appendChild(button);
      }
      row.append(meta,actions);
      host.appendChild(row);
    });
  }
  async function loadMarket(force) {
    const status = document.getElementById('addons-status');
    if (status) status.textContent = 'جارٍ تحميل الإضافات الرسمية والمجتمعية...';
    try {
      const official = parseList(JSON.parse(nativeText('https://api.strem.io/addonscollection.json')))
        .map(x => normalizeAddon(x,'official')).filter(Boolean);
      let community = [];
      try {
        const data = JSON.parse(nativeText('https://stremio-addons.net/api/v0/addons?sort_by=stars&order=desc&limit=100&page=1'));
        community = parseList(data).map(x => normalizeAddon(x,'community')).filter(Boolean);
      } catch (_) {
        try {
          const data = JSON.parse(nativeText('https://stremio-addons.com/addon_catalog/all/community.json'));
          community = parseList(data).map(x => normalizeAddon(x,'community')).filter(Boolean);
        } catch (_) {}
      }
      market = {official,community};
      if (status) status.textContent = official.length + ' إضافات رسمية و' + community.length + ' إضافات مجتمعية';
    } catch (error) {
      if (status) status.textContent = 'تعذر تحديث السوق حالياً. الإضافات المثبتة تعمل بشكل مستقل.';
    }
    renderAddons();
  }
  function openMarketplace() {
    loadInstalled();
    activeTab = 'installed';
    searchText = '';
    const input = document.getElementById('addons-search');
    if (input) input.value = '';
    renderAddons();
    openModal('modal-addons');
    if (!market.official.length && !market.community.length) loadMarket();
  }
  async function installAddon(addon, button) {
    if (isInstalled(addon)) return;
    button.disabled = true;
    button.textContent = 'جارٍ التحقق...';
    try {
      if (addon.configurationRequired) throw new Error('هذه الإضافة تتطلب إعداداً خارجياً قبل التثبيت.');
      const manifest = JSON.parse(nativeText(addon.url));
      if (!manifest || !manifest.id || !manifest.version || !Array.isArray(manifest.resources)) {
        throw new Error('ملف Manifest غير مكتمل أو غير صالح.');
      }
      const clean = normalizeAddon({...addon,...manifest,url:addon.url},addon.source);
      if (!clean) throw new Error('تعذر قراءة بيانات الإضافة.');
      clean.enabled = true;
      installed.push(clean);
      saveInstalled();
      renderAddons();
      if (typeof showToast === 'function') showToast('تم تثبيت ' + clean.name);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'تثبيت';
      if (typeof showToast === 'function') showToast(error.message || 'تعذر تثبيت الإضافة');
    }
  }
  function activeIdentity() {
    const item = videoPlaybackController && videoPlaybackController.currentItem;
    if (!item) throw new Error('شغّل فيلماً أو حلقة أولاً للبحث عن ترجمتها.');
    const isSeries = !!(item.subtitleSeries || item.seriesTitle || (typeof currentAppMode !== 'undefined' && currentAppMode === 'series'));
    const title = String(item.subtitleTitle || item.seriesTitle || item.name || '').trim();
    if (!title) throw new Error('اسم المحتوى غير متوفر للبحث.');
    return {item,isSeries,title,season:Number(item.subtitleSeason || item.season || 0),episode:Number(item.subtitleEpisode || item.episode || 0)};
  }
  function normalizeTitle(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g,''); }
  function resolveImdb(identity) {
    const type = identity.isSeries ? 'series' : 'movie';
    const url = 'https://v3-cinemeta.strem.io/catalog/' + type + '/top/search=' + encodeURIComponent(identity.title) + '.json';
    const data = JSON.parse(nativeText(url));
    const metas = data && Array.isArray(data.metas) ? data.metas : [];
    const target = normalizeTitle(identity.title);
    metas.sort((a,b) => {
      const aa = normalizeTitle(a.name || a.title), bb = normalizeTitle(b.name || b.title);
      const score = x => x === target ? 0 : (x.includes(target) || target.includes(x) ? 1 : 2);
      return score(aa)-score(bb);
    });
    const match = metas.find(x => /^tt\d+$/.test(String(x.imdb_id || x.id || '')));
    if (!match) throw new Error('لم يتم العثور على معرف الفيلم أو المسلسل في Cinemeta.');
    const id = String(match.imdb_id || match.id);
    if (identity.isSeries && identity.season > 0 && identity.episode > 0) {
      return {type:'series',id,resourceId:id+':'+identity.season+':'+identity.episode};
    }
    return {type,id,resourceId:id};
  }
  function normalizeLang(value) {
    const v = String(value || '').toLowerCase().replace('_','-');
    const aliases = {ara:'ar',eng:'en',hin:'hi',urd:'ur'};
    return aliases[v] || v;
  }
  async function searchOnline() {
    if (subtitleBusy) return;
    const status = document.getElementById('subtitle-search-status');
    const list = document.getElementById('subtitle-results');
    if (!list) return;
    subtitleBusy = true;
    list.replaceChildren();
    if (status) status.textContent = 'جارٍ البحث في مصادر الترجمة المثبتة...';
    try {
      const identity = activeIdentity();
      const imdb = resolveImdb(identity);
      const addons = installed.filter(x => x.enabled !== false && (x.resources || []).some(r => String(r).toLowerCase() === 'subtitles'));
      if (!addons.length) throw new Error('لا توجد إضافات ترجمة مفعّلة. افتح Addons لتثبيت مصدر ترجمة.');
      const results = [];
      for (const addon of addons) {
        try {
          const base = addon.url.replace(/\/manifest\.json(?:\?.*)?$/,'').replace(/\/+$/,'');
          const url = base + '/subtitles/' + imdb.type + '/' + encodeURIComponent(imdb.resourceId) + '.json';
          const payload = JSON.parse(nativeText(url));
          const rows = payload && Array.isArray(payload.subtitles) ? payload.subtitles : [];
          rows.forEach(row => {
            const lang = normalizeLang(row.lang);
            if (subtitleLanguage !== 'all' && lang !== subtitleLanguage && !lang.startsWith(subtitleLanguage+'-')) return;
            if (!/^https?:\/\//i.test(String(row.url || ''))) return;
            results.push({url:row.url,label:row.label || row.lang || addon.name,language:lang,addon:addon.name});
          });
        } catch (error) { console.warn('Subtitle addon failed: '+addon.name,error); }
      }
      const seen = new Set();
      subtitleResults = results.filter(x => {
        const key = x.url;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      subtitleResults.sort((a,b) => (a.language === subtitleLanguage ? -1 : 0) - (b.language === subtitleLanguage ? -1 : 0));
      renderSubtitleResults();
      if (status) status.textContent = subtitleResults.length ? 'تم العثور على ' + subtitleResults.length + ' ترجمة' : 'لم يتم العثور على ترجمة لهذه اللغة.';
    } catch (error) {
      if (status) status.textContent = error.message || 'تعذر البحث عن الترجمة.';
    } finally { subtitleBusy = false; }
  }
  function renderSubtitleResults() {
    const host = document.getElementById('subtitle-results');
    if (!host) return;
    host.replaceChildren();
    subtitleResults.forEach((entry,index) => {
      const button = document.createElement('button');
      button.className = 'subtitle-result focusable';
      const main = document.createElement('span');
      main.className = 'subtitle-result-main';
      const title = document.createElement('strong'); title.textContent = entry.label;
      const details = document.createElement('small'); details.textContent = entry.language.toUpperCase() + ' · ' + entry.addon;
      main.append(title,details);
      const action = document.createElement('span'); action.textContent = 'تحميل';
      button.append(main,action);
      button.addEventListener('click', () => applyOnlineSubtitle(index,button));
      host.appendChild(button);
    });
  }
  function applyOnlineSubtitle(index,button) {
    const entry = subtitleResults[index];
    if (!entry || !window.NativePlayback || !window.NativePlayback.applySubtitle) {
      if (typeof showToast === 'function') showToast('تطبيق الترجمة غير متاح');
      return;
    }
    button.disabled = true;
    button.querySelector('span:last-child').textContent = 'جارٍ التحميل...';
    try {
      const result = JSON.parse(window.NativePlayback.applySubtitle(entry.url,entry.label) || '{}');
      if (!result.success) throw new Error(result.error || 'تعذر تحميل الترجمة');
      currentSubtitleLabel = entry.label;
      const status = document.getElementById('subtitle-search-status');
      if (status) status.textContent = 'تم تطبيق الترجمة: ' + entry.label;
      if (typeof showToast === 'function') showToast('تم تحميل الترجمة وتفعيلها');
    } catch (error) {
      button.disabled = false;
      button.querySelector('span:last-child').textContent = 'تحميل';
      if (typeof showToast === 'function') showToast(error.message || 'تعذر تطبيق الترجمة');
    }
  }
  function applyStyle() {
    if (!window.NativePlayback || !window.NativePlayback.setSubtitleStyle) return;
    const colors = {white:'#FFFFFF',yellow:'#FFFF00',cyan:'#00FFFF',green:'#00FF66'};
    const color = colors[subtitleStyle.color] || subtitleStyle.color;
    try {
      window.NativePlayback.setSubtitleStyle(subtitleStyle.font,String(subtitleStyle.size),color,
        subtitleStyle.background,subtitleStyle.outline,subtitleStyle.position);
    } catch (error) { console.warn('Unable to apply subtitle style',error); }
  }
  function openSubtitleSearch() {
    subtitleResults = [];
    const title = document.getElementById('subtitle-content-title');
    const status = document.getElementById('subtitle-search-status');
    const list = document.getElementById('subtitle-results');
    try {
      const identity = activeIdentity();
      if (title) title.textContent = identity.title;
      const noTracks = !window.NativePlayback || !window.NativePlayback.hasTextTracks || !window.NativePlayback.hasTextTracks();
      const noStream = document.getElementById('subtitle-no-stream');
      if (noStream) noStream.style.display = noTracks ? 'block' : 'none';
      if (status) status.textContent = 'اختر اللغة ثم ابحث عن الترجمة عبر الإضافات المثبتة.';
      if (list) list.replaceChildren();
    } catch (error) {
      if (title) title.textContent = 'لا يوجد محتوى قيد التشغيل';
      if (status) status.textContent = error.message;
    }
    renderSubtitleStyle();
    openModal('modal-subtitles');
  }
  function renderSubtitleStyle() {
    const font = document.getElementById('subtitle-font');
    const size = document.getElementById('subtitle-size');
    const color = document.getElementById('subtitle-color');
    const background = document.getElementById('subtitle-background');
    const outline = document.getElementById('subtitle-outline');
    const position = document.getElementById('subtitle-position');
    if (font) font.value = subtitleStyle.font;
    if (size) size.value = String(subtitleStyle.size);
    if (color) color.value = subtitleStyle.color;
    if (background) background.value = subtitleStyle.background;
    if (outline) outline.value = subtitleStyle.outline;
    if (position) position.value = subtitleStyle.position;
  }
  function bind() {
    loadInstalled();
    document.getElementById('btn-toggle-subtitles')?.addEventListener('click', event => {
      event.preventDefault();
      openSubtitleSearch();
    });
    document.getElementById('settings-open-addons')?.addEventListener('click', openMarketplace);
    document.querySelectorAll('[data-addon-tab]').forEach(button => button.addEventListener('click', () => {
      activeTab = button.dataset.addonTab;
      document.querySelectorAll('[data-addon-tab]').forEach(x => x.classList.toggle('active',x === button));
      renderAddons();
    }));
    document.getElementById('addons-search')?.addEventListener('input', event => {
      searchText = event.target.value || ''; renderAddons();
    });
    document.getElementById('addons-refresh')?.addEventListener('click', () => loadMarket(true));
    document.getElementById('subtitle-search-button')?.addEventListener('click', searchOnline);
    document.getElementById('subtitle-language-list')?.addEventListener('click', event => {
      const button = event.target.closest('[data-subtitle-language]');
      if (!button) return;
      subtitleLanguage = button.dataset.subtitleLanguage;
      document.querySelectorAll('[data-subtitle-language]').forEach(x => x.classList.toggle('active',x === button));
    });
    document.getElementById('subtitle-stop')?.addEventListener('click', () => {
      if (window.NativePlayback && window.NativePlayback.clearSubtitle) window.NativePlayback.clearSubtitle();
      currentSubtitleLabel = '';
      if (typeof showToast === 'function') showToast('تم إيقاف الترجمة');
    });
    document.getElementById('subtitle-add-file')?.addEventListener('click', () => {
      if (window.NativePlayback && window.NativePlayback.pickSubtitle) window.NativePlayback.pickSubtitle();
      else if (typeof showToast === 'function') showToast('اختيار الملفات غير متاح');
    });
    document.getElementById('subtitle-font')?.addEventListener('change', e => { subtitleStyle.font=e.target.value; saveStyle(); });
    document.getElementById('subtitle-size')?.addEventListener('change', e => { subtitleStyle.size=Number(e.target.value); saveStyle(); });
    document.getElementById('subtitle-color')?.addEventListener('change', e => { subtitleStyle.color=e.target.value; saveStyle(); });
    document.getElementById('subtitle-background')?.addEventListener('change', e => { subtitleStyle.background=e.target.value; saveStyle(); });
    document.getElementById('subtitle-outline')?.addEventListener('change', e => { subtitleStyle.outline=e.target.value; saveStyle(); });
    document.getElementById('subtitle-position')?.addEventListener('change', e => { subtitleStyle.position=e.target.value; saveStyle(); });
    applyStyle();
  }
  window.SonixSubtitles = {
    openSearch:openSubtitleSearch,
    openMarketplace,
    applyStyle,
    refresh:loadMarket,
    onLocalSubtitleResult:function (success,label,message) {
      const status=document.getElementById('subtitle-search-status');
      if (status) status.textContent = success ? 'تمت إضافة الترجمة: '+label : (message || 'تعذر إضافة ملف الترجمة');
      if (success) currentSubtitleLabel=label || 'ترجمة محلية';
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',bind);
  else bind();
})();