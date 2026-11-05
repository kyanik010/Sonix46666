    /**
     * =========================================================================
     * SECTION 6: UNIFIED DATA MODELS (CHANNELS, MOVIES, SERIES)
     * =========================================================================
     */
    // Mode State: 'live' | 'movies' | 'series'
    let currentAppMode = 'live';

    const SONIX_SETTINGS_KEY = 'sonix_user_settings_v1';
    const SONIX_DEFAULT_SETTINGS = {
      quality: 720,
      subtitles: true,
      favoritesFirst: false,
      rememberSection: true,
      rememberItem: true,
      textScale: 100
    };
    function readSonixSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem(SONIX_SETTINGS_KEY) || '{}');
        const value = {...SONIX_DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {})};
        value.quality = [480,720,1080].includes(Number(value.quality)) ? Number(value.quality) : 720;
        value.textScale = [90,100,110,120].includes(Number(value.textScale)) ? Number(value.textScale) : 100;
        ['subtitles','favoritesFirst','rememberSection','rememberItem'].forEach(key => value[key] = value[key] !== false);
        return value;
      } catch (_) { return {...SONIX_DEFAULT_SETTINGS}; }
    }
    let sonixSettings = readSonixSettings();
    function saveSonixSettings() {
      try { localStorage.setItem(SONIX_SETTINGS_KEY, JSON.stringify(sonixSettings)); }
      catch (error) { console.warn('Unable to save SONIX settings', error); }
    }
    function applySonixAppearance() {
      document.documentElement.style.fontSize = (16 * sonixSettings.textScale / 100) + 'px';
    }
    function syncSonixSettingsControls() {
      const values = {
        'settings-quality': sonixSettings.quality,
        'settings-subtitles': sonixSettings.subtitles,
        'settings-favorites-first': sonixSettings.favoritesFirst,
        'settings-remember-section': sonixSettings.rememberSection,
        'settings-remember-item': sonixSettings.rememberItem,
        'settings-text-scale': sonixSettings.textScale
      };
      Object.entries(values).forEach(([id,value]) => {
        const control = document.getElementById(id);
        if (!control) return;
        if (control.type === 'checkbox') control.checked = Boolean(value);
        else control.value = String(value);
      });
    }
    function updateSonixSetting(key, value) {
      sonixSettings[key] = value;
      saveSonixSettings();
      if (key === 'textScale') applySonixAppearance();
      if (key === 'favoritesFirst' && currentActiveCategory === 'all') renderItems();
      if (key === 'subtitles' && videoPlaybackController) {
        videoPlaybackController.subtitlesEnabled = Boolean(value);
        if (window.NativePlayback && window.NativePlayback.setSubtitlesEnabled) {
          window.NativePlayback.setSubtitlesEnabled(Boolean(value));
        }
        const button = document.getElementById('btn-toggle-subtitles');
        if (button) {
          button.classList.toggle('is-active', Boolean(value));
          button.setAttribute('aria-pressed', String(Boolean(value)));
        }
        const label = document.getElementById('subtitle-label');
        if (label) label.textContent = value ? 'إخفاء الترجمة' : 'الترجمة';
      }
      if (key === 'quality' && window.NativePlayback && window.NativePlayback.isActive &&
          window.NativePlayback.isActive() && window.NativePlayback.setVideoQuality) {
        window.NativePlayback.setVideoQuality(Number(value));
        const label = document.getElementById('quality-label');
        if (label) label.textContent = Number(value) + 'p';
        document.querySelectorAll('.player-quality-option').forEach(option =>
          option.setAttribute('aria-pressed', String(Number(option.dataset.quality) === Number(value))));
      }
    }
    function initializeSonixSettingsControls() {
      syncSonixSettingsControls();
      applySonixAppearance();
      const bindings = [
        ['settings-quality','quality',value => Number(value)],
        ['settings-subtitles','subtitles',Boolean],
        ['settings-favorites-first','favoritesFirst',Boolean],
        ['settings-remember-section','rememberSection',Boolean],
        ['settings-remember-item','rememberItem',Boolean],
        ['settings-text-scale','textScale',value => Number(value)]
      ];
      bindings.forEach(([id,key,convert]) => {
        const control = document.getElementById(id);
        if (control) control.addEventListener('change', () => updateSonixSetting(key, convert(control.type === 'checkbox' ? control.checked : control.value)));
      });
    }

    // 1. LIVE CHANNELS
    // Provider data stays empty until the user authenticates with Xtream Codes.
    let liveCategories = [], liveChannels = [];
    let movieCategories = [], movies = [];
    let seriesCategories = [], series = [];
    let activeCredentials = null, accountInfo = null, isOfflineCache = false;
    const FAVORITES_STORAGE_KEY = 'sonix_favorites_v2';
    function readSavedFavorites() {
      try {
        const values = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || '[]');
        return Array.isArray(values) ? values.filter(value => typeof value === 'string') : [];
      } catch (_) { return []; }
    }
    const memoryFavorites = new Set(readSavedFavorites());
    try { localStorage.removeItem('sonix_favorites_v1'); } catch (_) {}
    const saveFavorites = () => {
      try { localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...memoryFavorites])); }
      catch (error) { console.warn('Unable to persist favorites', error); }
    };
    function favoriteKey(itemId, mode = currentAppMode) {
      const account = activeCredentials
        ? String(activeCredentials.server || '') + '|' + String(activeCredentials.username || '')
        : 'unbound';
      return account + ':' + mode + ':' + String(itemId);
    }
    function isFavorite(itemId, mode = currentAppMode) {
      return memoryFavorites.has(favoriteKey(itemId, mode));
    }
    function resolveProviderImageUrl(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      try {
        const base = activeCredentials && activeCredentials.server ? activeCredentials.server : document.baseURI;
        const url = new URL(raw, base);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
      } catch (_) { return ''; }
    }
    function setProviderImage(container, value, alt, fallbackText = '') {
      if (!container) return;
      container.textContent = fallbackText || '';
      const src = resolveProviderImageUrl(value);
      if (!src) return;
      const image = document.createElement('img');
      image.className = 'provider-logo';
      image.alt = alt || '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.src = src;
      image.onerror = () => {
        image.remove();
        if (!container.querySelector('img')) container.textContent = fallbackText || '';
      };
      container.replaceChildren(image);
    }

    /**
     * =========================================================================
     * SECTION 11 & 12: VIDEO ENGINE & DUAL AUDIO
     * =========================================================================
     */
    class VideoPlaybackController {
      constructor() {
        this.viewport = document.querySelector('.video-viewport');
        this.loaderEl = document.getElementById('player-loader');
        this.loaderText = document.getElementById('player-loader-text');
        this.errorEl = document.getElementById('player-error');
        this.currentItem = null;
        this.retryAttempts = 0;
        this.maxRetries = 3;
        this.isFullscreen = false;
        this.fullscreenOriginalParent = null;
        this.fullscreenOriginalNextSibling = null;
        this.isMuted = false;
        this.subtitlesEnabled = sonixSettings.subtitles;
        this.controlsHideTimer = null;
        this.isSeekingTimeline = false;
        this.timelineDurationMs = 0;
        this.pendingPlayToken = 0;
        this.viewportResizeObserver = null;
        if (this.viewport && typeof ResizeObserver !== 'undefined') {
          this.viewportResizeObserver = new ResizeObserver(() => this.syncNativeBounds());
          this.viewportResizeObserver.observe(this.viewport);
        }
        this.bindEvents();
      }

      bindEvents() {
        if (this.viewport) {
          this.viewport.addEventListener('pointerdown', () => this.showPlaybackControls());
          this.viewport.addEventListener('click', (event) => {
            if (!event.target.closest('.player-playback-controls')) {
              this.showPlaybackControls();
            }
          });
        }
        const playbackControls = document.getElementById('player-playback-controls');
        if (playbackControls) {
          playbackControls.addEventListener('pointerdown', () => this.showPlaybackControls());
          playbackControls.addEventListener('click', () => this.showPlaybackControls());
        }
        document.getElementById('player-retry-action').addEventListener('click', () => {
          if (this.currentItem) {
            this.syncNativeBounds();
            this.loadItem(this.currentItem);
          }
        });
        document.getElementById('ctrl-mute-btn').addEventListener('click', () => this.toggleMute());
        document.getElementById('ctrl-seek-back').addEventListener('click', () => this.seekBy(-10000));
        document.getElementById('ctrl-seek-forward').addEventListener('click', () => this.seekBy(10000));
        const seekBar = document.getElementById('player-seek-bar');
        if (seekBar) {
          seekBar.addEventListener('pointerdown', () => {
            this.isSeekingTimeline = true;
            this.showPlaybackControls();
          });
          seekBar.addEventListener('input', () => {
            this.isSeekingTimeline = true;
            this.showPlaybackControls();
            const target = this.timelineDurationMs * (Number(seekBar.value) / 1000);
            const currentLabel = document.getElementById('player-current-time');
            if (currentLabel) currentLabel.textContent = this.formatTimelineTime(target);
            seekBar.style.setProperty('--progress', (Number(seekBar.value) / 10) + '%');
            seekBar.setAttribute('aria-valuenow', seekBar.value);
          });
          seekBar.addEventListener('change', () => {
            const target = this.timelineDurationMs * (Number(seekBar.value) / 1000);
            this.isSeekingTimeline = false;
            this.seekToPosition(target);
          });
          seekBar.addEventListener('pointercancel', () => { this.isSeekingTimeline = false; });
          seekBar.addEventListener('focus', () => this.showPlaybackControls());
          seekBar.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'Left' &&
                event.key !== 'ArrowRight' && event.key !== 'Right') return;
            event.preventDefault();
            event.stopPropagation();
            this.showPlaybackControls();
            this.seekBy((event.key === 'ArrowRight' || event.key === 'Right') ? 10000 : -10000);
          });
        }
        window.addEventListener('keydown', () => {
          if (this.isFullscreen) this.showPlaybackControls();
        }, true);
        document.getElementById('btn-toggle-subtitles').addEventListener('click', () => this.toggleSubtitles());
        document.getElementById('btn-quality').addEventListener('click', () => this.toggleQualityMenu());
        document.querySelectorAll('.player-quality-option').forEach(option => option.addEventListener('click', () => {
          const quality=Number(option.dataset.quality);
          if (window.NativePlayback && window.NativePlayback.setVideoQuality) {
            window.NativePlayback.setVideoQuality(quality);
            updateSonixSetting('quality', quality);
            document.querySelectorAll('.player-quality-option').forEach(el => el.setAttribute('aria-pressed', String(el===option)));
            document.getElementById('quality-label').textContent=option.textContent;
            document.getElementById('player-quality-menu').classList.remove('open');
            document.getElementById('btn-quality').setAttribute('aria-expanded','false');
          }
        }));
        document.getElementById('btn-playback-fav').addEventListener('click', () => {
          if (this.currentItem) toggleFavorite(this.currentItem.id);
        });
        if (this.viewport) {
          let lastTapTime = 0;
          this.viewport.addEventListener('touchend', (e) => {
            // Toolbar taps operate their controls; only a double tap on the video
            // surface itself may leave fullscreen.
            if (e.target.closest('.player-playback-controls, .player-timeline, .control-btn, .action-btn')) return;
            const now = Date.now();
            if (now - lastTapTime < 350 && now - lastTapTime > 40) {
              e.preventDefault();
              this.toggleFullscreen();
            }
            lastTapTime = now;
          });
        }
        window.addEventListener('resize', () => this.syncNativeBounds());
        window.addEventListener('scroll', () => this.syncNativeBounds(), true);
      }

      showPlaybackControls() {
        // Playback controls are fullscreen-only. Ignore taps and remote navigation
        // while the native video is embedded in the preview panel.
        if (!this.isFullscreen || !this.currentItem || !window.NativePlayback || !window.NativePlayback.isActive()) return;
        const controls = document.getElementById('player-playback-controls');
        if (!controls) return;
        controls.classList.add('visible');
        const timeline = document.getElementById('player-timeline');
        if (timeline && this.viewport && this.viewport.classList.contains('has-vod-timeline')) {
          timeline.classList.add('visible');
        }
        if (this.viewport) this.viewport.classList.add('playback-controls-visible');
        if (this.controlsHideTimer) clearTimeout(this.controlsHideTimer);
        this.controlsHideTimer = setTimeout(() => this.hidePlaybackControls(), 10000);
      }

      hidePlaybackControls() {
        // Keep the fullscreen toolbar available behind the external-audio dialog.
        // Otherwise its 10-second auto-hide timer can leave the close action
        // without a visible/focusable return target on TV remotes.
        const audioDialog = document.getElementById('modal-ext-audio');
        const subtitleDialog = document.getElementById('modal-subtitles');
        if (this.isFullscreen && ((audioDialog && audioDialog.classList.contains('active')) ||
            (subtitleDialog && subtitleDialog.classList.contains('active')))) {
          if (this.controlsHideTimer) clearTimeout(this.controlsHideTimer);
          this.controlsHideTimer = null;
          return;
        }
        const controls = document.getElementById('player-playback-controls');
        if (controls) {
          controls.classList.remove('visible');
          const timeline = document.getElementById('player-timeline');
          if (timeline) timeline.classList.remove('visible');
          const menu = document.getElementById('player-quality-menu');
          if (menu) menu.classList.remove('open');
          const qualityButton = document.getElementById('btn-quality');
          if (qualityButton) qualityButton.setAttribute('aria-expanded', 'false');
        }
        if (this.viewport) this.viewport.classList.remove('playback-controls-visible');
        if (this.controlsHideTimer) clearTimeout(this.controlsHideTimer);
        this.controlsHideTimer = null;
      }

      loadItem(item) {
        if (!item) return;
        if (dualAudioEngine && dualAudioEngine.isActive &&
            dualAudioEngine.selectedSourceChannel &&
            String(dualAudioEngine.selectedSourceChannel.id) === String(item.id)) {
          dualAudioEngine.stopExternalAudio(false);
        }
        this.currentItem = item;
        this.hidePlaybackControls();
        const playerPanel=document.querySelector('.live-player-col'); if(playerPanel) playerPanel.classList.remove('has-active-playback');
        this.retryAttempts = 0;
        this.errorEl.classList.remove('active');
        this.showLoader('جارٍ الاتصال بـ ' + (item.name || 'المحتوى') + '...');
        const streamUrl = String(item.streamUrl || '').trim();
        if (!streamUrl) {
          if (window.NativePlayback) window.NativePlayback.stop();
          this.showError('رابط التشغيل غير متوفر من اشتراك IPTV.');
          return;
        }
        if (!window.NativePlayback || typeof window.NativePlayback.play !== 'function') {
          this.showError('واجهة مشغل Android الأصلية غير متاحة.');
          return;
        }
        this.updateUiInfo(item);
        // The native bridge owns player replacement and stops the previous stream
        // exactly once, after the new viewport bounds have been validated.
        // The preview host is a dedicated, non-shrinking layout slot. Still wait
        // for WebView layout to publish real bounds; transient zero-size frames are
        // retried instead of being mistaken for a stream/player failure.
        const playToken = ++this.pendingPlayToken;
        const tryStartNativePlayback = (attempt = 0) => {
          if (playToken !== this.pendingPlayToken || this.currentItem !== item) return;
          const viewport = this.viewport;
          if (!viewport || !viewport.isConnected) {
            if (window.NativePlayback && typeof window.NativePlayback.stop === 'function') window.NativePlayback.stop();
            this.showError('تعذر تحديد مساحة عرض الفيديو.');
            return;
          }
          const style = window.getComputedStyle(viewport);
          const rect = viewport.getBoundingClientRect();
          const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity) !== 0;
          const isWithinWindow = rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
          if (!visible || !isWithinWindow) {
            if (attempt < 15) {
              requestAnimationFrame(() => setTimeout(() => tryStartNativePlayback(attempt + 1), 80));
              return;
            }
            console.error('[SONIXSurface] preview host did not obtain visible bounds', JSON.stringify({
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              display: style.display, visibility: style.visibility, opacity: style.opacity,
              parent: viewport.parentElement ? {
                width: viewport.parentElement.getBoundingClientRect().width,
                height: viewport.parentElement.getBoundingClientRect().height,
                display: window.getComputedStyle(viewport.parentElement).display
              } : null
            }));
            if (window.NativePlayback && typeof window.NativePlayback.stop === 'function') window.NativePlayback.stop();
            this.showError('تعذر تجهيز مساحة معاينة الفيديو. أعد المحاولة.');
            return;
          }
          const pixelRatio = window.devicePixelRatio || 1;
          const cornerRadius = this.isFullscreen ? 0 : 16;
          console.info('[SONIXSurface] valid preview host before native play', JSON.stringify({
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            display: style.display, visibility: style.visibility, opacity: style.opacity,
            dpr: pixelRatio, cornerRadius, attempt
          }));
          // Native Media3 remains the sole video renderer; Android applies the matching clip.
          if (item.streamDescriptor && window.NativePlayback.playStream) {
            window.NativePlayback.playStream(item.streamDescriptor.type, String(item.streamDescriptor.id), item.streamDescriptor.ext, rect.left, rect.top, rect.width, rect.height, pixelRatio, cornerRadius);
          } else {
            window.NativePlayback.play(streamUrl, rect.left, rect.top, rect.width, rect.height, pixelRatio, cornerRadius);
          }
          if (window.NativePlayback.setVideoQuality) window.NativePlayback.setVideoQuality(Number(sonixSettings.quality));
          if (window.NativePlayback.setSubtitlesEnabled) window.NativePlayback.setSubtitlesEnabled(Boolean(sonixSettings.subtitles));
        };
        requestAnimationFrame(() => requestAnimationFrame(() => {
          setTimeout(() => tryStartNativePlayback(), 80);
        }));
      }

      syncNativeBounds() {
        if (!this.currentItem || !window.NativePlayback || typeof window.NativePlayback.resize !== 'function' || !this.viewport) return;
        requestAnimationFrame(() => {
          if (!this.currentItem || !window.NativePlayback || !this.viewport) return;
          const rect = this.viewport.getBoundingClientRect();
          // Always synchronize visibility as well as size. Keeping the last non-zero
          // bounds when the viewport is hidden/collapsed leaves a stale native overlay.
          window.NativePlayback.resize(
            rect.left || 0, rect.top || 0,
            rect.width || 0, rect.height || 0,
            window.devicePixelRatio || 1, this.isFullscreen ? 0 : 16
          );
        });
      }

      showLoader(msg) {
        this.loaderText.textContent = msg || 'جارٍ التحميل...';
        this.loaderEl.classList.add('active');
      }

      hideLoader() {
        this.loaderEl.classList.remove('active');
        this.errorEl.classList.remove('active');
      }

      showError(msg) {
        this.loaderEl.classList.remove('active');
        const message = this.errorEl.querySelector('div:nth-child(2)');
        if (message) message.textContent = msg || 'تعذر تشغيل المحتوى.';
        this.errorEl.classList.add('active');
      }

      updatePlaybackState(isPlaying) {
        const icon = document.getElementById('icon-play-state');
        const button = document.getElementById('ctrl-play-pause');
        if (icon && button) {
          icon.innerHTML = isPlaying
            ? '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>'
            : '<polygon points="5,3 19,12 5,21" fill="currentColor"/>';
          button.title = isPlaying ? 'إيقاف مؤقت' : 'تشغيل';
        }
      }

      togglePlayPause() {
        if (!window.NativePlayback || !window.NativePlayback.isActive()) {
          if (this.currentItem) this.loadItem(this.currentItem);
          return;
        }
        window.NativePlayback.toggle();
      }

      toggleMute() {
        if (dualAudioEngine && dualAudioEngine.isActive) {
          showToast('الصوت الأساسي مكتوم تلقائياً أثناء تشغيل مصدر صوت خارجي');
          return;
        }
        this.isMuted = !this.isMuted;
        if (window.NativePlayback) window.NativePlayback.setMuted(this.isMuted);
        const label=document.getElementById('mute-label');
        if(label) label.textContent=this.isMuted ? 'إلغاء الكتم' : 'كتم الصوت';
        const button=document.getElementById('ctrl-mute-btn');
        if(button) button.classList.toggle('is-active',this.isMuted);
      }

      formatTimelineTime(milliseconds) {
        const totalSeconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const mm = String(minutes).padStart(2, '0');
        const ss = String(seconds).padStart(2, '0');
        return hours > 0 ? hours + ':' + mm + ':' + ss : mm + ':' + ss;
      }

      updateTimeline(positionMs, durationMs, seekable) {
        const timeline = document.getElementById('player-timeline');
        const seekBar = document.getElementById('player-seek-bar');
        if (!timeline || !seekBar) return;
        const duration = Number(durationMs);
        const position = Math.max(0, Number(positionMs) || 0);
        const usable = currentAppMode !== 'live' && !!seekable && Number.isFinite(duration) && duration > 0;
        timeline.classList.toggle('available', usable);
        seekBar.disabled = !usable;
        if (!usable) {
          this.timelineDurationMs = 0;
          return;
        }
        this.timelineDurationMs = duration;
        const totalLabel = document.getElementById('player-total-time');
        if (totalLabel) totalLabel.textContent = this.formatTimelineTime(duration);
        if (!this.isSeekingTimeline) {
          const ratio = Math.max(0, Math.min(1, position / duration));
          seekBar.value = String(Math.round(ratio * 1000));
          seekBar.setAttribute('aria-valuenow', seekBar.value);
          seekBar.style.setProperty('--progress', (ratio * 100) + '%');
          const currentLabel = document.getElementById('player-current-time');
          if (currentLabel) currentLabel.textContent = this.formatTimelineTime(position);
        }
      }

      seekToPosition(positionMs) {
        if (currentAppMode === 'live' || !window.NativePlayback) return;
        const target = Math.max(0, Math.min(this.timelineDurationMs, Number(positionMs) || 0));
        if (typeof window.NativePlayback.seekTo === 'function') {
          window.NativePlayback.seekTo(Math.round(target));
        } else if (typeof window.NativePlayback.seekBy === 'function') {
          const current = this.timelineDurationMs * (Number(document.getElementById('player-seek-bar')?.value || 0) / 1000);
          window.NativePlayback.seekBy(Math.round(target - current));
        }
        this.showPlaybackControls();
      }

      seekBy(offsetMs) {
        if (currentAppMode === 'live') {
          showToast('التقديم والإرجاع متاحان للأفلام والمسلسلات فقط');
          return;
        }
        if (!window.NativePlayback || !window.NativePlayback.seekBy) return;
        window.NativePlayback.seekBy(offsetMs);
      }

      toggleSubtitles() {
        if (window.SonixSubtitles && window.SonixSubtitles.openSearch) {
          window.SonixSubtitles.openSearch();
          return;
        }
        showToast('واجهة الترجمة غير جاهزة');
      }

      toggleQualityMenu() {
        const menu=document.getElementById('player-quality-menu');
        const button=document.getElementById('btn-quality');
        if(!menu||!button) return;
        const open=!menu.classList.contains('open');
        menu.classList.toggle('open',open);
        button.setAttribute('aria-expanded',String(open));
      }

      pause() {
        if (window.NativePlayback) window.NativePlayback.pause();
        if (dualAudioEngine) dualAudioEngine.pause();
      }

      toggleFullscreen() {
        if (!this.viewport) return;
        const enteringFullscreen = !this.isFullscreen;

        if (enteringFullscreen) {
          this.fullscreenPreviousFocus = remoteNavigator
            ? remoteNavigator.currentFocusedElement
            : document.activeElement;
          // Move the viewport out of the app's multi-column layout. This avoids
          // fixed-position elements being clipped by transformed/overflow ancestors.
          this.fullscreenOriginalParent = this.viewport.parentNode;
          this.fullscreenOriginalNextSibling = this.viewport.nextSibling;
          // Preserve live-channel control layout after the viewport is portaled
          // out of .live-player-col into document.body.
          const playerPanel = document.querySelector('.live-player-col');
          this.viewport.classList.toggle('is-live-mode', !!(playerPanel && playerPanel.classList.contains('is-live-mode')));
          document.body.appendChild(this.viewport);
          document.body.classList.add('sonix-video-fullscreen');
          this.isFullscreen = true;
          this.viewport.classList.add('is-fullscreen');
          // Ask Android to hide system bars and let the native video surface fill
          // the physical display, not just the WebView's content area.
          if (window.NativePlayback && typeof window.NativePlayback.setFullscreen === 'function') {
            window.NativePlayback.setFullscreen(true);
          }
        } else {
          // Hide controls and dismiss any open quality menu before restoring preview.
          this.hidePlaybackControls();
          this.isFullscreen = false;
          this.viewport.classList.remove('is-fullscreen', 'is-live-mode');
          document.body.classList.remove('sonix-video-fullscreen');
          // Restore Android system bars and the normal uncropped preview scaling.
          if (window.NativePlayback && typeof window.NativePlayback.setFullscreen === 'function') {
            window.NativePlayback.setFullscreen(false);
          }
          const parent = this.fullscreenOriginalParent;
          if (parent) {
            if (this.fullscreenOriginalNextSibling &&
                this.fullscreenOriginalNextSibling.parentNode === parent) {
              parent.insertBefore(this.viewport, this.fullscreenOriginalNextSibling);
            } else {
              parent.appendChild(this.viewport);
            }
          }
          this.fullscreenOriginalParent = null;
          this.fullscreenOriginalNextSibling = null;
          const previousFocus = this.fullscreenPreviousFocus;
          this.fullscreenPreviousFocus = null;
          if (remoteNavigator) {
            const canRestoreFocus = previousFocus && previousFocus.isConnected &&
              previousFocus.getClientRects().length > 0;
            const selectedRow = document.querySelector('.channel-row.selected');
            const fallbackFocus = selectedRow || remoteNavigator.getVisibleFocusableElements()[0];
            remoteNavigator.focusElement(canRestoreFocus ? previousFocus : fallbackFocus);
          }
        }

        // Wait for the portal/layout transition, then resize the native surface
        // to exactly match the new viewport rectangle.
        requestAnimationFrame(() => this.syncNativeBounds());
        if (this.isFullscreen) {
          this.showPlaybackControls();
          showToast('تم التكبير إلى ملء الشاشة');
          const firstControl = document.querySelector('#player-playback-controls .playback-control-btn');
          if (firstControl && remoteNavigator) remoteNavigator.focusElement(firstControl);
        } else {
          showToast('تم الخروج من وضع ملء الشاشة');
        }
      }

      exitFullscreen() {
        if (this.isFullscreen) {
          this.toggleFullscreen();
          return true;
        }
        return false;
      }

      updateUiInfo(item) {
        document.getElementById('ticker-cat').textContent = item.categoryName || '';
        document.getElementById('ticker-ch').textContent = item.name || '';
        const scoreOverlay = document.getElementById('player-score-overlay');
        const playerPanel = document.querySelector('.live-player-col');
        if (playerPanel) playerPanel.classList.toggle('is-live-mode', currentAppMode === 'live');
        if (this.viewport) this.viewport.classList.toggle('has-vod-timeline', currentAppMode !== 'live');
        if (scoreOverlay) scoreOverlay.style.display = currentAppMode === 'live' ? 'flex' : 'none';
        if (currentAppMode === 'live') {
          document.getElementById('epg-modal-channel-name').textContent = 'دليل البرامج - ' + item.name;
          document.getElementById('epg-curr-title').textContent = item.epgTitle || 'بث مباشر';
          document.getElementById('epg-curr-desc').textContent = item.epgDesc || 'لا توجد تفاصيل إضافية لهذا البرنامج.';
          document.getElementById('epg-next-title').textContent = item.epgNext || 'البرنامج التالي';
        }
        updateFavoriteButtons(item.id);
      }

      stopAndRelease() {
        this.pendingPlayToken++;
        if (dualAudioEngine) dualAudioEngine.stopExternalAudio(false);
        if (window.NativePlayback) window.NativePlayback.stop();
        this.hidePlaybackControls();
        const playerPanel=document.querySelector('.live-player-col'); if(playerPanel) playerPanel.classList.remove('has-active-playback');
        this.currentItem = null;
        this.updatePlaybackState(false);
      }
    }

    /**
     * =========================================================================
     * SECTION 12: DUAL AUDIO SYSTEM
     * =========================================================================
     */
    class DualAudioSystem {
      constructor(videoController) {
        this.videoController = videoController; this.selectedSourceChannel = null; this.isActive = false;
        this.delayMs = 0; this.volume = 1; this.originalVideoMuted = false;
        this.statusTextEl = document.getElementById('ext-audio-status-text'); this.statusPillEl = document.getElementById('ext-audio-status-pill');
        this.delayLabelEl = document.getElementById('delay-value-label'); this.activeBadgeEl = document.getElementById('ext-audio-badge');
        this.btnExtAudioText = document.getElementById('ext-audio-btn-text'); this.btnExtAudio = document.getElementById('btn-open-ext-audio');
        this.sourceNameEl = document.getElementById('selected-audio-source-name'); this.bindEvents(); this.updateDelayLabel();
      }
      bindEvents() {
        document.getElementById('btn-start-audio').addEventListener('click', () => this.startExternalAudio());
        document.getElementById('btn-stop-audio').addEventListener('click', () => this.stopExternalAudio());
        document.getElementById('delay-plus-100').addEventListener('click', () => this.adjustDelay(100));
        document.getElementById('delay-minus-100').addEventListener('click', () => this.adjustDelay(-100));
        document.getElementById('delay-plus-500').addEventListener('click', () => this.adjustDelay(500));
        document.getElementById('delay-minus-500').addEventListener('click', () => this.adjustDelay(-500));
        document.getElementById('delay-reset').addEventListener('click', () => this.resetDelay());
        const slider = document.getElementById('external-audio-volume');
        if (slider) slider.addEventListener('input', () => { this.volume = Math.max(0, Math.min(1, Number(slider.value) / 100)); document.getElementById('external-audio-volume-label').textContent = Math.round(this.volume * 100) + '%'; if (window.NativePlayback) window.NativePlayback.setExternalAudioVolume(this.volume); });
      }
      setSourceChannel(channel) {
        if (!channel || !channel.id) return;
        const currentVideo = this.videoController.currentItem;
        // Compare stable Xtream stream IDs only. streamUrl is deliberately not
        // used here because native playback stores the placeholder native://stream
        // on every item, not the resolved provider URL.
        if (currentVideo && String(currentVideo.id) === String(channel.id)) {
          showToast('اختر قناة صوتية مختلفة عن قناة الفيديو');
          return;
        }
        this.selectedSourceChannel = channel;
        this.sourceNameEl.textContent = channel.name + ' (' + channel.categoryName + ')';
        document.querySelectorAll('.audio-picker-item').forEach(el =>
          el.classList.toggle('active', el.dataset.channelId === String(channel.id))
        );
        showToast('تم اختيار ' + channel.name + ' — جارٍ تشغيل الصوت الخارجي');
        this.startExternalAudio();
      }
      startExternalAudio() {
        const source = this.selectedSourceChannel;
        if (!source || !source.id) {
          showToast('يرجى اختيار قناة صوتية من beIN SPORTS أو ALWAN أولاً');
          return;
        }
        if (!window.NativePlayback || typeof window.NativePlayback.attachExternalAudioStream !== 'function') {
          this.setStatus('failed', 'مصدر الصوت غير متاح');
          showToast('تعذر الحصول على رابط القناة الصوتية من الاشتراك');
          return;
        }
        if (!this.isActive) this.originalVideoMuted = !!this.videoController.isMuted;
        this.videoController.isMuted = true;
        this.isActive = true;
        this.setStatus('connecting', 'جارٍ الاتصال...');
        this.activeBadgeEl.classList.add('visible');
        this.btnExtAudio.classList.add('is-active');
        this.btnExtAudioText.textContent = 'الصوت الخارجي: ' + source.name;
        window.NativePlayback.setExternalAudioVolume(this.volume);
        window.NativePlayback.setExternalAudioSyncOffset(this.delayMs);
        // Pass the real provider stream ID to the native secondary Media3 player.
        // Never overwrite channel.streamUrl with the shared native://stream placeholder.
        window.NativePlayback.attachExternalAudioStream(
          String(source.id),
          source.containerExtension || 'ts'
        );
      }
      onBuffering() { if (this.isActive) this.setStatus('connecting', 'جارٍ الاتصال أو إعادة المحاولة...'); }
      onPlaying() { if (this.isActive) { this.setStatus('playing', 'يعمل'); showToast('بدأ تشغيل القناة الصوتية المستقلة عبر Media3'); } }
      onFailure(message) { this.stopExternalAudio(false, false); this.setStatus('failed', 'فشل الاتصال'); showToast(message || 'فشل تشغيل مصدر الصوت الخارجي؛ تمت استعادة صوت الفيديو'); }
      stopExternalAudio(showMessage = true, notifyNative = true) {
        if (notifyNative && window.NativePlayback) window.NativePlayback.detachExternalAudio();
        this.isActive = false;
        this.videoController.isMuted = this.originalVideoMuted;
        this.originalVideoMuted = false; this.delayMs = 0; this.updateDelayLabel();
        this.activeBadgeEl.classList.remove('visible'); this.btnExtAudio.classList.remove('is-active'); this.btnExtAudioText.textContent = 'الصوت الخارجي'; this.setStatus('stopped', 'متوقف');
        if (showMessage) showToast('تم إيقاف الصوت الخارجي واستعادة صوت القناة الأساسية');
      }
      adjustDelay(deltaMs) {
        this.delayMs = Math.max(-10000, Math.min(10000, this.delayMs + deltaMs)); this.updateDelayLabel();
        if (window.NativePlayback) window.NativePlayback.setExternalAudioSyncOffset(this.delayMs);
        showToast(this.delayMs > 0 ? 'تأخير الصوت ' + this.delayMs + ' مللي ثانية' : this.delayMs < 0 ? 'تقديم الصوت ' + Math.abs(this.delayMs) + ' مللي ثانية' : 'فرق التوقيت صفر');
      }
      resetDelay() { this.delayMs = 0; this.updateDelayLabel(); if (window.NativePlayback) window.NativePlayback.setExternalAudioSyncOffset(0); }
      updateDelayLabel() { this.delayLabelEl.textContent = (this.delayMs > 0 ? '+' : '') + this.delayMs + ' ms'; }
      setStatus(type, label) { this.statusPillEl.className = 'audio-status-pill status-' + type; this.statusTextEl.textContent = label; }
      pause() { if (window.NativePlayback) window.NativePlayback.pauseExternalAudio(); }
      resume() { if (this.isActive && window.NativePlayback) window.NativePlayback.resumeExternalAudio(); }
      releaseAll() { this.stopExternalAudio(false); }
    }
    window.onExternalAudioBuffering = function() { if (dualAudioEngine) dualAudioEngine.onBuffering(); };
    window.onExternalAudioPlaying = function() { if (dualAudioEngine) dualAudioEngine.onPlaying(); };
    window.onExternalAudioError = function(message) { if (dualAudioEngine) dualAudioEngine.onFailure(message); };
    window.onExternalAudioStopped = function() { if (dualAudioEngine && dualAudioEngine.isActive) dualAudioEngine.stopExternalAudio(false, false); };
    /**
     * =========================================================================
     * SECTION 8: D-PAD & TV REMOTE SPATIAL NAVIGATION SYSTEM
     * =========================================================================
     */
    class RemoteControlNavigator {
      constructor() {
        this.currentFocusedElement = null;
        window.remoteNavigator = this; // Expose on window for Android key forwarding
        this.bindKeyEvents();
      }

      bindKeyEvents() {
        window.addEventListener('keydown', (e) => {
          // Native text editors and the TV IME own every key while an editable
          // control has focus. Back/Escape must never become app navigation here.
          const editingElement = document.activeElement;
          const isEditingText = editingElement &&
            (editingElement.matches('input, textarea, select') || editingElement.isContentEditable);
          if (isEditingText) {
            if (e.key === 'Escape' || e.key === 'Back') e.preventDefault();
            return;
          }

          const activeModal = document.querySelector('.modal-backdrop.active');
          if (activeModal) {
            this.handleModalKey(e, activeModal);
            return;
          }

          if (videoPlaybackController && videoPlaybackController.currentItem &&
              (e.key === 'ArrowUp' || e.key === 'Up' ||
               e.key === 'ArrowDown' || e.key === 'Down' ||
               e.key === 'ArrowLeft' || e.key === 'Left' ||
               e.key === 'ArrowRight' || e.key === 'Right')) {
            const controls = document.getElementById('player-playback-controls');
            if (videoPlaybackController.isFullscreen && controls && !controls.classList.contains('visible')) {
              e.preventDefault();
              videoPlaybackController.showPlaybackControls();
              const seekBar = document.getElementById('player-seek-bar');
              const firstControl = seekBar && !seekBar.disabled &&
                videoPlaybackController.viewport.classList.contains('has-vod-timeline')
                ? seekBar
                : controls.querySelector('.playback-control-btn:not([disabled])');
              if (firstControl) this.focusElement(firstControl);
              return;
            }
            if (videoPlaybackController.isFullscreen && controls && controls.classList.contains('visible')) {
              videoPlaybackController.showPlaybackControls();
            }
          }
          switch (e.key) {
            case 'ArrowUp':
            case 'Up':
              e.preventDefault();
              this.navigateSpatial('up');
              break;
            case 'ArrowDown':
            case 'Down':
              e.preventDefault();
              this.navigateSpatial('down');
              break;
            case 'ArrowLeft':
            case 'Left':
              e.preventDefault();
              this.navigateSpatial('left');
              break;
            case 'ArrowRight':
            case 'Right':
              e.preventDefault();
              this.navigateSpatial('right');
              break;
            case 'Enter':
              if (this.currentFocusedElement &&
                  this.currentFocusedElement.matches('.channel-row.selected') &&
                  videoPlaybackController && videoPlaybackController.currentItem &&
                  !videoPlaybackController.isFullscreen &&
                  window.NativePlayback && window.NativePlayback.isActive()) {
                // A second OK/Enter on the selected playing item enters fullscreen
                // on TV remotes, where double-click/touch gestures are unavailable.
                videoPlaybackController.toggleFullscreen();
              } else if (this.currentFocusedElement) {
                this.currentFocusedElement.click();
              }
              break;
            case 'Escape':
            case 'Back':
            case 'Backspace':
              e.preventDefault();
              this.handleBackAction();
              break;
          }
        });
      }

      handleModalKey(e, modal) {
        if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Back') {
          e.preventDefault();
          closeAllModals();
          return;
        }

        const focusables = Array.from(modal.querySelectorAll('.focusable:not([disabled])'));
        if (!focusables.length) return;

        let currentIndex = focusables.indexOf(document.activeElement);
        if (currentIndex === -1) currentIndex = 0;

        if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const nextIndex = (currentIndex + 1) % focusables.length;
          this.focusElement(focusables[nextIndex]);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
          e.preventDefault();
          const prevIndex = (currentIndex - 1 + focusables.length) % focusables.length;
          this.focusElement(focusables[prevIndex]);
        }
      }

      handleBackAction() {
        // The login gate is a standalone screen, not a view. Back must not
        // route around it or open the power dialog while credentials are entered.
        const loginScreen = document.getElementById('sonix-login-screen');
        if (loginScreen && !loginScreen.classList.contains('hidden')) return;

        const editingElement = document.activeElement;
        if (editingElement &&
            (editingElement.matches('input, textarea, select') || editingElement.isContentEditable)) {
          editingElement.blur();
          return;
        }

        // A dialog opened over fullscreen video owns Back until it is dismissed.
        // Exiting fullscreen first would strand the audio dialog in the hidden app tree.
        const activeModal = document.querySelector('.modal-backdrop.active');
        if (activeModal) {
          closeAllModals();
          return;
        }

        // Only exit fullscreen when no modal is currently covering the video.
        if (videoPlaybackController && videoPlaybackController.isFullscreen) {
          videoPlaybackController.exitFullscreen();
          return;
        }

        // If in Live/Movies/Series content browser, return to Home screen!
        const currentActiveView = document.querySelector('.view-screen.active');
        if (currentActiveView && currentActiveView.id !== 'view-home') {
          switchView('view-home');
        } else {
          openModal('modal-power');
        }
      }

      navigateSpatial(direction) {
        if (!this.currentFocusedElement) {
          const visibleFocusables = this.getVisibleFocusableElements();
          if (visibleFocusables.length) {
            this.focusElement(visibleFocusables[0]);
          }
          return;
        }

        // 1. Sequential navigation for lists; media grids move vertically by one row.
        const currentListContainer = this.currentFocusedElement.closest('.categories-list, .channels-list, .audio-channel-picker, #global-search-results');
        if (currentListContainer && (direction === 'up' || direction === 'down')) {
          const listItems = Array.from(currentListContainer.querySelectorAll('.focusable:not([disabled])'));
          const idx = listItems.indexOf(this.currentFocusedElement);
          if (idx !== -1 && currentListContainer.classList.contains('media-grid')) {
            const rowStep = 3;
            if (direction === 'up' && idx >= rowStep) {
              this.focusElement(listItems[idx - rowStep]);
              return;
            }
            if (direction === 'down') {
              if (listItems[idx + rowStep]) {
                this.focusElement(listItems[idx + rowStep]);
                return;
              }
              if (loadMoreChannelRows()) {
                const expandedItems = Array.from(currentListContainer.querySelectorAll('.focusable:not([disabled])'));
                if (expandedItems[idx + rowStep]) {
                  this.focusElement(expandedItems[idx + rowStep]);
                  return;
                }
              }
            }
          } else if (idx !== -1) {
            if (direction === 'down' && idx < listItems.length - 1) {
              this.focusElement(listItems[idx + 1]);
              return;
            } else if (direction === 'up' && idx > 0) {
              this.focusElement(listItems[idx - 1]);
              return;
            } else if (direction === 'down' && currentListContainer.classList.contains('channels-list')) {
              if (loadMoreChannelRows()) {
                const expandedItems = Array.from(currentListContainer.querySelectorAll('.focusable:not([disabled])'));
                if (expandedItems[idx + 1]) this.focusElement(expandedItems[idx + 1]);
                return;
              }
            }
          }
        }

        // 2. Spatial geometric fallback across different columns and screen regions
        const visibleFocusables = this.getVisibleFocusableElements();
        if (!visibleFocusables.length) return;

        const currentRect = this.currentFocusedElement.getBoundingClientRect();
        let bestTarget = null;
        let minDistance = Infinity;

        visibleFocusables.forEach(target => {
          if (target === this.currentFocusedElement) return;
          const rect = target.getBoundingClientRect();

          let isCandidate = false;
          let primaryDist = 0;
          let secondaryDist = 0;

          if (direction === 'up' && rect.bottom <= currentRect.top + 8) {
            isCandidate = true;
            primaryDist = currentRect.top - rect.bottom;
            secondaryDist = Math.abs((rect.left + rect.width / 2) - (currentRect.left + currentRect.width / 2));
          } else if (direction === 'down' && rect.top >= currentRect.bottom - 8) {
            isCandidate = true;
            primaryDist = rect.top - currentRect.bottom;
            secondaryDist = Math.abs((rect.left + rect.width / 2) - (currentRect.left + currentRect.width / 2));
          } else if (direction === 'left' && rect.right <= currentRect.left + 8) {
            isCandidate = true;
            primaryDist = currentRect.left - rect.right;
            secondaryDist = Math.abs((rect.top + rect.height / 2) - (currentRect.top + currentRect.height / 2));
          } else if (direction === 'right' && rect.left >= currentRect.right - 8) {
            isCandidate = true;
            primaryDist = rect.left - currentRect.right;
            secondaryDist = Math.abs((rect.top + rect.height / 2) - (currentRect.top + currentRect.height / 2));
          }

          if (isCandidate) {
            const distance = primaryDist * 1.0 + secondaryDist * 1.5;
            if (distance < minDistance) {
              minDistance = distance;
              bestTarget = target;
            }
          }
        });

        if (bestTarget) {
          this.focusElement(bestTarget);
        }
      }

      getVisibleFocusableElements() {
        const loginScreen = document.getElementById('sonix-login-screen');
        if (loginScreen && !loginScreen.classList.contains('hidden')) {
          return Array.from(loginScreen.querySelectorAll('.focusable:not([disabled])'))
            .filter(element => element.getClientRects().length > 0);
        }
        const activeModal = document.querySelector('.modal-backdrop.active');
        if (activeModal) {
          const selector = '.focusable:not([disabled])';
          return Array.from(activeModal.querySelectorAll(selector)).filter(element => element.getClientRects().length > 0);
        }
        const fullscreenViewport = videoPlaybackController && videoPlaybackController.isFullscreen
          ? videoPlaybackController.viewport
          : null;
        const selector = '.focusable:not([disabled])';
        const candidates = fullscreenViewport
          ? Array.from(fullscreenViewport.querySelectorAll(selector))
          : Array.from(document.querySelectorAll('.view-screen.active ' + selector));
        return candidates.filter(element => element.getClientRects().length > 0);
      }

      focusElement(element) {
        if (!element) return;
        if (this.currentFocusedElement) {
          this.currentFocusedElement.classList.remove('keyboard-focused');
        }
        this.currentFocusedElement = element;
        element.classList.add('keyboard-focused');
        try {
          element.focus({ preventScroll: true });
          if (typeof element.scrollIntoView === 'function') {
            element.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
          }
        } catch (err) {
          console.warn('focusElement non-critical error', err);
        }
      }
    }

    // Expose global back handler for Android MainActivity
    window.handleAndroidBack = function() {
      if (window.remoteNavigator) {
        window.remoteNavigator.handleBackAction();
      } else {
        switchView('view-home');
      }
    };

    // Global reset to home screen whenever app is resumed
    window.ensureHomeScreen = function() {
      closeAllModals();
      if (videoPlaybackController && videoPlaybackController.isFullscreen) {
        videoPlaybackController.exitFullscreen();
      }
      switchView('view-home');
    };

    /**
     * =========================================================================
     * SECTION 1: ARABIC-INDIC CLOCK FORMATTER
     * =========================================================================
     */
    function toArabicIndicDigits(str) {
      const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
      return String(str).replace(/[0-9]/g, w => arabicDigits[+w]);
    }

    function updateLiveClock() {
      const now = new Date();
      let hours = now.getHours();
      const minutes = now.getMinutes();
      const isPm = hours >= 12;
      hours = hours % 12;
      hours = hours ? hours : 12;

      const formattedHours = hours < 10 ? '0' + hours : hours;
      const formattedMins = minutes < 10 ? '0' + minutes : minutes;
      const ampm = isPm ? 'م' : 'ص';

      const timeText = `${toArabicIndicDigits(formattedHours)}:${toArabicIndicDigits(formattedMins)} ${ampm}`;
      const clockDigitsEl = document.getElementById('home-clock-digits');
      if (clockDigitsEl) clockDigitsEl.textContent = timeText;

      const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
      const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
      const dayName = days[now.getDay()];
      const monthName = months[now.getMonth()];
      const dayNum = toArabicIndicDigits(now.getDate());

      const clockDateEl = document.getElementById('home-clock-date');
      if (clockDateEl) clockDateEl.textContent = `${dayName}، ${dayNum} ${monthName}`;
    }

    /**
     * =========================================================================
     * SECTION 3 & 5: VIEW SWITCHING & APP MODES (LIVE, MOVIES, SERIES)
     * =========================================================================
     */
    function switchView(viewId) {
      if (viewId === 'view-home') {
        if (videoPlaybackController) {
          if (videoPlaybackController.isFullscreen) videoPlaybackController.exitFullscreen();
          videoPlaybackController.stopAndRelease();
        } else if (window.NativePlayback) {
          window.NativePlayback.stop();
        }
        if (dualAudioEngine) dualAudioEngine.stopExternalAudio(false);
      }

      document.querySelectorAll('.view-screen').forEach(el => el.classList.remove('active'));
      const target = document.getElementById(viewId);
      if (target) {
        target.classList.add('active');
        let elementToFocus = null;
        if (viewId === 'view-home') {
          elementToFocus = document.getElementById('card-channels');
        } else if (viewId === 'view-live') {
          elementToFocus = target.querySelector('.category-item.selected') || document.getElementById('live-btn-back');
        }
        if (!elementToFocus) elementToFocus = target.querySelector('.focusable');
        if (elementToFocus && remoteNavigator) remoteNavigator.focusElement(elementToFocus);
      }
    }

    function openModal(modalId) {
      closeAllModals();
      if (modalId === 'modal-settings') syncSonixSettingsControls();
      const modal = document.getElementById(modalId);
      if (!modal) return;

      const isFullscreenAudioDialog = modalId === 'modal-ext-audio' &&
        !!(videoPlaybackController && videoPlaybackController.isFullscreen);
      const isSubtitlePopover = modalId === 'modal-subtitles';

      // Both playback dialogs must escape the hidden app subtree after the
      // video viewport is portaled to <body> in fullscreen.
      if ((isFullscreenAudioDialog || isSubtitlePopover) && modal.parentElement !== document.body) {
        modal._sonixOriginalParent = modal.parentElement;
        modal._sonixOriginalNextSibling = modal.nextSibling;
        document.body.appendChild(modal);
        modal.dataset.sonixFullscreenPortal = 'true';
      }
      if (isSubtitlePopover) {
        modal.classList.add('sonix-subtitle-popover');
        const trigger = document.getElementById('btn-toggle-subtitles');
        const panel = modal.querySelector('.subtitles-window');
        const positionPopover = () => {
          if (!modal.classList.contains('active') || !trigger || !panel) return;
          const anchor = trigger.getBoundingClientRect();
          const margin = 8;
          const maxHeight = Math.max(180, Math.min(window.innerHeight * 0.78, 620));
          panel.style.maxHeight = maxHeight + 'px';
          const bounds = panel.getBoundingClientRect();
          const width = bounds.width || Math.min(560, window.innerWidth - margin * 2);
          const height = Math.min(bounds.height || panel.scrollHeight, maxHeight);
          const left = Math.max(margin, Math.min(
            anchor.left + anchor.width / 2 - width / 2,
            window.innerWidth - width - margin
          ));
          let top = anchor.top - height - 10;
          if (top < margin) top = Math.min(window.innerHeight - height - margin, anchor.bottom + 10);
          top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
          panel.style.left = left + 'px';
          panel.style.top = top + 'px';
        };
        modal._sonixSubtitlePositionHandler = positionPopover;
        modal._sonixSubtitleOutsideHandler = event => {
          if (!panel?.contains(event.target) && event.target !== trigger) closeAllModals();
        };
        window.addEventListener('resize', positionPopover);
        window.addEventListener('scroll', positionPopover, true);
        document.addEventListener('pointerdown', modal._sonixSubtitleOutsideHandler, true);
      }

      modal.setAttribute('aria-hidden', 'false');
      modal.classList.add('active');
      if ((isFullscreenAudioDialog || isSubtitlePopover) && videoPlaybackController) {
        videoPlaybackController.showPlaybackControls();
      }

      const focusDialog = () => {
        if (!modal.classList.contains('active')) return;
        if (isSubtitlePopover && modal._sonixSubtitlePositionHandler) modal._sonixSubtitlePositionHandler();
        const firstFocusable = modal.querySelector('.focusable:not([disabled])');
        if (firstFocusable && remoteNavigator) remoteNavigator.focusElement(firstFocusable);
      };
      if (isFullscreenAudioDialog || isSubtitlePopover) {
        requestAnimationFrame(() => {
          modal.getBoundingClientRect();
          focusDialog();
        });
      } else {
        focusDialog();
      }
    }

    function closeAllModals() {
      let closedFullscreenAudio = false;
      let closedSubtitlePopover = false;
      document.querySelectorAll('.modal-backdrop').forEach(el => {
        if (el.id === 'modal-ext-audio' && el.dataset.sonixFullscreenPortal === 'true') {
          closedFullscreenAudio = true;
        }
        if (el.id === 'modal-subtitles' && el.classList.contains('sonix-subtitle-popover')) {
          closedSubtitlePopover = true;
          if (el._sonixSubtitlePositionHandler) {
            window.removeEventListener('resize', el._sonixSubtitlePositionHandler);
            window.removeEventListener('scroll', el._sonixSubtitlePositionHandler, true);
            delete el._sonixSubtitlePositionHandler;
          }
          if (el._sonixSubtitleOutsideHandler) {
            document.removeEventListener('pointerdown', el._sonixSubtitleOutsideHandler, true);
            delete el._sonixSubtitleOutsideHandler;
          }
          const panel = el.querySelector('.subtitles-window');
          if (panel) {
            panel.style.left = '';
            panel.style.top = '';
            panel.style.maxHeight = '';
          }
          el.classList.remove('sonix-subtitle-popover');
        }
        el.classList.remove('active');
        el.setAttribute('aria-hidden', 'true');
        if (el.dataset.sonixFullscreenPortal === 'true' && el._sonixOriginalParent) {
          const parent = el._sonixOriginalParent;
          const next = el._sonixOriginalNextSibling;
          if (next && next.parentNode === parent) parent.insertBefore(el, next);
          else parent.appendChild(el);
          delete el._sonixOriginalParent;
          delete el._sonixOriginalNextSibling;
          delete el.dataset.sonixFullscreenPortal;
        }
      });

      if ((closedFullscreenAudio || closedSubtitlePopover) && videoPlaybackController && videoPlaybackController.isFullscreen) {
        videoPlaybackController.showPlaybackControls();
        if (remoteNavigator) {
          const returnButton = document.getElementById(closedSubtitlePopover ? 'btn-toggle-subtitles' : 'btn-open-ext-audio');
          if (returnButton) remoteNavigator.focusElement(returnButton);
        }
      }
    }

    let toastTimer = null;
    function showToast(message) {
      const toast = document.getElementById('toast-msg');
      const text = document.getElementById('toast-text');
      if (!toast || !text) return;

      text.textContent = message;
      toast.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.classList.remove('show');
      }, 2500);
    }

    function parseNative(raw) {
      const value = JSON.parse(raw);
      if (value && value.success === false) throw new Error(value.error || 'فشل طلب الخادم');
      return value;
    }
    function isNetworkFailure(error) {
      const message = String(error && error.message ? error.message : error || '');
      return /تعذر العثور على خادم|انتهت مهلة الاتصال|تعذر الاتصال بخادم|فشل اتصال الخادم|قوائم محتوى فارغة|unable to resolve|failed to connect|connection refused|timed out|network|HTTP 5\d\d/i.test(message);
    }
    function nativeArray(action, fromCache = false) {
      const raw = fromCache ? window.XtreamBridge.loadCached(action) : window.XtreamBridge.load(action);
      const value = parseNative(raw);
      if (!Array.isArray(value)) throw new Error('استجابة غير صالحة من الخادم: ' + action);
      return value;
    }
    function makeCategories(rows, prefix) {
      return rows.map(row => ({id:prefix + String(row.category_id), providerId:String(row.category_id), name:row.category_name || 'تصنيف'}));
    }
    // Keep the two built-in entries first in every content section, including restored offline caches.
    function orderCategories(categories, allLabel) {
      const source = Array.isArray(categories) ? categories : [];
      const all = source.find(category => category && category.id === 'all') || {id:'all',name:allLabel};
      const favorites = source.find(category => category && category.id === 'favorites') || {id:'favorites',name:'المفضلة'};
      return [favorites, all, ...source.filter(category =>
        category && category.id !== 'favorites' && category.id !== 'all')];
    }
    function makeStreamUrl(type, id, item) {
      if (!activeCredentials || !window.XtreamBridge) return '';
      const ext = (item.container_extension || (type === 'live' ? 'ts' : 'mp4')).replace(/^\./,'');
      return parseNative(window.XtreamBridge.streamUrl(type,String(id),ext)).url;
    }
    function loadXtreamContent(fromCache = false) {
      const lc = makeCategories(nativeArray('get_live_categories',fromCache),'live-');
      const mc = makeCategories(nativeArray('get_vod_categories',fromCache),'movie-');
      const sc = makeCategories(nativeArray('get_series_categories',fromCache),'series-');
      const categoryName = (list,prefix,id) => (list._nameById && list._nameById.get(String(id))) || '';
      [lc,mc,sc].forEach(list => { list._nameById = new Map(list.map(item => [item.providerId, item.name])); });
      const rawLive = nativeArray('get_live_streams',fromCache);
      const rawMovies = nativeArray('get_vod_streams',fromCache);
      const rawSeries = nativeArray('get_series',fromCache);
      if (rawLive.length + rawMovies.length + rawSeries.length === 0) {
        throw new Error('أعاد الخادم قوائم محتوى فارغة؛ لن نستبدل البيانات السابقة');
      }
      liveCategories = orderCategories([{id:'all',name:'جميع القنوات'}, ...lc, {id:'favorites',name:'المفضلة'}], 'جميع القنوات');
      liveChannels = rawLive.map((x,i) => ({id:String(x.stream_id),number:i+1,name:x.name || 'قناة',
        category:x.category_id == null ? '' : 'live-' + x.category_id,categoryName:categoryName(lc,'live-',x.category_id),
        logo:x.stream_icon || '',logoText:'',streamUrl:'',
        epgChannelId:x.epg_channel_id || '',containerExtension:x.container_extension || 'ts'}));
      movieCategories = orderCategories([{id:'all',name:'جميع الأفلام'}, ...mc, {id:'favorites',name:'المفضلة'}], 'جميع الأفلام');
      movies = rawMovies.map((x,i) => ({id:String(x.stream_id),number:i+1,name:x.name || 'فيلم',
        category:x.category_id == null ? '' : 'movie-' + x.category_id,categoryName:categoryName(mc,'movie-',x.category_id),
        logo:x.stream_icon || '',logoText:'',streamUrl:'',
        rating:x.rating || '',desc:x.plot || '',containerExtension:x.container_extension || 'mp4'}));
      seriesCategories = orderCategories([{id:'all',name:'جميع المسلسلات'}, ...sc, {id:'favorites',name:'المفضلة'}], 'جميع المسلسلات');
      series = rawSeries.map((x,i) => ({id:String(x.series_id),seriesId:String(x.series_id),number:i+1,name:x.name || 'مسلسل',
        category:x.category_id == null ? '' : 'series-' + x.category_id,categoryName:categoryName(sc,'series-',x.category_id),
        logo:x.cover || '',logoText:'',streamUrl:'',rating:x.rating || '',desc:x.plot || ''}));
      // XtreamBridge persists each API response atomically as it arrives.
      // The native cache is marked complete only after all six responses exist.
      isOfflineCache = Boolean(fromCache);
      const cacheNote=document.getElementById('cache-status'); if(cacheNote) cacheNote.style.display='none';
      renderCategories(); renderItems(); renderAudioSourcePicker();
    }
    function restoreXtreamCache() {
      try {
        // Read the six already-synchronized API responses from Android storage.
        // This path performs no provider network requests.
        loadXtreamContent(true);
        const hasContent=liveChannels.length + movies.length + series.length > 0;
        isOfflineCache=hasContent;
        const cacheNote=document.getElementById('cache-status'); if(cacheNote) cacheNote.style.display=hasContent?'block':'none';
        return hasContent;
      } catch (nativeCacheError) {
        // Keep compatibility with the older WebView cache for an upgrade path.
        try {
          const c=JSON.parse(localStorage.getItem('sonix_provider_cache_v1') || 'null');
          if (!c || !Array.isArray(c.liveChannels) || !Array.isArray(c.movies) ||
              !Array.isArray(c.series) || !Array.isArray(c.liveCategories) ||
              !Array.isArray(c.movieCategories) || !Array.isArray(c.seriesCategories)) return false;
          liveCategories=orderCategories(c.liveCategories,'جميع القنوات'); liveChannels=c.liveChannels;
          movieCategories=orderCategories(c.movieCategories,'جميع الأفلام'); movies=c.movies;
          seriesCategories=orderCategories(c.seriesCategories,'جميع المسلسلات'); series=c.series;
          const hasContent=liveChannels.length + movies.length + series.length > 0;
          const cacheNote=document.getElementById('cache-status'); if(cacheNote) cacheNote.style.display=hasContent?'block':'none';
          return hasContent;
        } catch (_) {
          console.warn('Unable to restore provider catalogue', nativeCacheError);
          return false;
        }
      }
    }
    function setLoginMessage(message, success) {
      const el=document.getElementById('sonix-login-message');
      if(el){el.textContent=message || '';el.style.color=success?'var(--success-green)':'var(--danger-red)';}
    }
    function updateAccount(user) {
      accountInfo=user || {};
      const exp=Number(accountInfo.exp_date || 0);
      document.getElementById('account-user-name').textContent=accountInfo.username || '—';
      document.getElementById('account-user-id').textContent=accountInfo.user_id || accountInfo.username || '—';
      document.getElementById('account-expiry').textContent=exp>0?new Date(exp*1000).toLocaleDateString('ar'):'غير محدد';
      const pn=document.getElementById('profile-user-name'); if(pn) pn.textContent=accountInfo.username || '—';
      const pi=document.getElementById('profile-user-id'); if(pi) pi.textContent=accountInfo.user_id || accountInfo.username || '—';
      const pe=document.getElementById('profile-expiry'); if(pe) pe.textContent=exp>0?new Date(exp*1000).toLocaleDateString('ar'):'غير محدد';
      const pp=document.getElementById('profile-package'); if(pp) pp.textContent=accountInfo.status || '—';
      const ps=document.getElementById('profile-server-status'); if(ps) ps.textContent=isOfflineCache?'بيانات مخزنة سابقاً':'تم التحقق من الاشتراك';
    }
    function performXtreamLogin(server,username,password,offlineFallback) {
      const button=document.getElementById('login-submit');
      button.disabled=true;button.textContent='جارٍ التحقق من الاشتراك...';setLoginMessage('');
      try {
        const result=parseNative(window.XtreamBridge.login(server,username,password));
        activeCredentials={server:server.trim().replace(/\/+$/,''),username:result.user_info.username || username};
        isOfflineCache=false;
        updateAccount(result.user_info);
        loadXtreamContent();
        const loginScreen = document.getElementById('sonix-login-screen');
        if (loginScreen.contains(document.activeElement)) document.activeElement.blur();
        loginScreen.classList.add('hidden');
        document.getElementById('login-password').value='';
        const settingsPassword=document.getElementById('iptv-password'); if(settingsPassword) settingsPassword.value='';
        showToast('تم التحقق من الاشتراك وتحميل محتوى الخادم');
      } catch(error) {
        if (offlineFallback) {
          try {
            const saved=parseNative(window.XtreamBridge.savedCredentials());
            activeCredentials={server:saved.server,username:saved.username};
          } catch (_) {}
        }
        if(offlineFallback && isNetworkFailure(error) && activeCredentials && restoreXtreamCache()) {
          isOfflineCache=true;
          updateAccount({username:activeCredentials.username});
          const loginScreen = document.getElementById('sonix-login-screen');
          if (loginScreen.contains(document.activeElement)) document.activeElement.blur();
          loginScreen.classList.add('hidden');
          showToast('تعذر الاتصال؛ يتم عرض آخر بيانات مخزنة');
          renderCategories();renderItems();renderAudioSourcePicker();
        } else {
          setLoginMessage(error.message || 'فشل تسجيل الدخول');
        }
      } finally {
        button.disabled=false;button.textContent='تسجيل الدخول';
      }
    }
    function openSeriesEpisodes(item) {
      try {
        const data=parseNative(window.XtreamBridge.seriesInfo(item.seriesId));
        const episodes=data.episodes || {};
        const list=document.getElementById('series-episodes-list');
        list.innerHTML='';
        const formatEpisodeDuration=(episode)=>{
          const info=episode.info || {};
          const raw=info.duration || episode.duration || '';
          if(raw && /^\\d{1,2}:\\d{2}:\\d{2}$/.test(String(raw))) return String(raw);
          const seconds=Number(info.duration_secs || episode.duration_secs || 0);
          if(seconds>0) {
            const h=Math.floor(seconds/3600);
            const m=Math.floor((seconds%3600)/60);
            const sec=seconds%60;
            return [h,m,sec].map(value=>String(value).padStart(2,'0')).join(':');
          }
          return raw ? String(raw) : 'المدة غير متاحة';
        };
        Object.keys(episodes).sort((a,b)=>Number(a)-Number(b)).forEach(season=>{
          const heading=document.createElement('div');
          heading.className='series-season-heading';
          heading.textContent='الموسم ' + season;
          list.appendChild(heading);
          (episodes[season] || []).forEach(ep=>{
            const episodeNumber=Number(ep.episode_num || 0);
            const episodeCode='S'+String(season).padStart(2,'0')+'E'+String(episodeNumber).padStart(2,'0');
            const info=ep.info || {};
            const thumbnailUrl=info.movie_image || info.cover_big || ep.movie_image || ep.cover || '';
            const card=document.createElement('button');
            card.type='button';
            card.className='episode-card focusable';
            card.setAttribute('role','listitem');
            card.setAttribute('aria-label',episodeCode+' '+(ep.title || 'الحلقة'));
            const thumbnail=document.createElement('span');
            thumbnail.className='episode-thumbnail';
            if(thumbnailUrl) {
              const image=document.createElement('img');
              image.src=thumbnailUrl;
              image.alt='';
              image.loading='lazy';
              image.onerror=()=>{ image.remove(); };
              thumbnail.appendChild(image);
            }
            const play=document.createElement('span');
            play.className='episode-play-icon';
            play.setAttribute('aria-hidden','true');
            play.textContent='▶';
            thumbnail.appendChild(play);
            const details=document.createElement('span');
            details.className='episode-details';
            const code=document.createElement('span');
            code.className='episode-code';
            code.textContent=episodeCode;
            const name=document.createElement('span');
            name.className='episode-name';
            name.textContent=ep.title || ('الحلقة '+(ep.episode_num || ''));
            const duration=document.createElement('span');
            duration.className='episode-duration';
            duration.textContent=formatEpisodeDuration(ep);
            details.append(code,name,duration);
            card.append(thumbnail,details);
            card.addEventListener('click',()=>{
              const ext=ep.container_extension || 'mp4';
              closeAllModals();
              selectItem({...item,seriesId:null,id:String(ep.id),name:ep.title || item.name,
                subtitleTitle:item.name,seriesTitle:item.name,subtitleSeries:true,
                subtitleSeason:Number(season),subtitleEpisode:episodeNumber,
                streamDescriptor:{type:'series',id:String(ep.id),ext:ext},streamUrl:'native://stream'});
            });
            list.appendChild(card);
          });
        });
        if(!list.querySelector('.episode-card')) throw new Error('لا توجد حلقات متاحة لهذا المسلسل');
        document.getElementById('series-episodes-modal').classList.add('active');
      } catch(error) { showToast(error.message || 'تعذر تحميل الحلقات'); }
    }
    function refreshXtreamContent(options = {}) {
      const silent = Boolean(options && options.silent);
      try {
        if(!activeCredentials) throw new Error('سجّل الدخول أولاً');
        const session=parseNative(window.XtreamBridge.restoreSession());
        isOfflineCache=false;
        updateAccount(session.user_info);
        loadXtreamContent();
        const status=document.getElementById('profile-server-status');
        if(status) status.textContent='تم التحقق من الاشتراك';
        if (!silent) showToast('تم تحديث المحتوى من خادم الاشتراك');
        return true;
      } catch(error) {
        const retryable = isNetworkFailure(error);
        const hasCache=!!(activeCredentials && retryable && restoreXtreamCache());
        isOfflineCache=hasCache;
        const note=document.getElementById('cache-status'); if(note) note.style.display=hasCache?'block':'none';
        const status=document.getElementById('profile-server-status');
        if(status) status.textContent=hasCache?'تعذر التحديث — بيانات سابقة':(retryable?'تعذر الاتصال بالخادم':'تعذر تحديث المحتوى');
        if (hasCache) { renderCategories(); renderItems(); renderAudioSourcePicker(); }
        if (!silent) showToast('فشل التحديث: ' + (error.message || 'تعذر الاتصال'));
        return false;
      }
    }

    /**
     * =========================================================================
     * UNIFIED CONTENT BROWSER ENGINE (CHANNELS, MOVIES, SERIES IN SAME 4 COLUMNS)
     * =========================================================================
     */
    let currentActiveCategory = '';
    let currentSelectedItem = null;
    let currentRenderedItems = [];
    let currentRenderedCount = 0;
    let channelRenderGeneration = 0;
    const CHANNEL_RENDER_BATCH_SIZE = 80;
    const CHANNEL_RENDER_PREFETCH_PX = 420;

    function appendChannelRows() {
      const container = document.getElementById('channels-list-container');
      if (!container || currentRenderedCount >= currentRenderedItems.length) return;
      const end = Math.min(currentRenderedCount + CHANNEL_RENDER_BATCH_SIZE, currentRenderedItems.length);
      const fragment = document.createDocumentFragment();
      for (let index = currentRenderedCount; index < end; index++) {
        const it = currentRenderedItems[index];
        const row = document.createElement('div');
        const isSelected = currentSelectedItem && currentSelectedItem.id === it.id;
        const isFav = isFavorite(it.id);
        row.className = `channel-row focusable ${isSelected ? 'selected' : ''}`;
        row.tabIndex = 0;
        row.dataset.itemId = it.id;
        row.innerHTML = `
          <span class="channel-number"></span>
          <div class="channel-logo-box"></div>
          <span class="channel-name"></span>
          <svg class="channel-fav-star ${isFav ? 'active' : ''}" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
          </svg>`;
        let lastRowTap = 0;
        row.addEventListener('click', () => selectItem(it));
        row.addEventListener('dblclick', event => {
          event.preventDefault(); selectItem(it);
          if (videoPlaybackController && !videoPlaybackController.isFullscreen) videoPlaybackController.toggleFullscreen();
        });
        row.addEventListener('touchend', event => {
          const now = Date.now();
          if (now - lastRowTap < 350 && now - lastRowTap > 40) {
            event.preventDefault(); selectItem(it);
            if (videoPlaybackController && !videoPlaybackController.isFullscreen) videoPlaybackController.toggleFullscreen();
          }
          lastRowTap = now;
        });
        row.querySelector('.channel-number').textContent = String(it.number || '');
        row.querySelector('.channel-name').textContent = it.name || '';
        setProviderImage(row.querySelector('.channel-logo-box'), it.logo, it.name, it.logoText || '');
        fragment.appendChild(row);
      }
      currentRenderedCount = end;
      container.appendChild(fragment);
    }

    function loadMoreChannelRows() {
      const before = currentRenderedCount;
      appendChannelRows();
      return currentRenderedCount > before;
    }

    function setAppMode(mode) {
      const previousMode = currentAppMode;
      if (previousMode !== mode) {
        if (window.NativePlayback && typeof window.NativePlayback.stop === 'function') {
          window.NativePlayback.stop();
        }
        if (videoPlaybackController) {
          videoPlaybackController.currentItem = null;
          videoPlaybackController.hidePlaybackControls();
        }
        const playerPanel = document.querySelector('.live-player-col');
        if (playerPanel) {
          playerPanel.classList.remove('has-active-playback');
          playerPanel.classList.toggle('is-live-mode', mode === 'live');
        }
      }
      currentAppMode = mode;
      const itemsContainer = document.getElementById('channels-list-container');
      if (itemsContainer) itemsContainer.classList.toggle('media-grid', mode === 'movies' || mode === 'series');
      if (sonixSettings.rememberSection) {
        try { localStorage.setItem('sonix_last_mode_v1', mode); } catch (_) {}
      }
      
      // Update sidebar nav highlights
      document.getElementById('side-nav-live').classList.toggle('active', mode === 'live');
      document.getElementById('side-nav-movies').classList.toggle('active', mode === 'movies');
      document.getElementById('side-nav-series').classList.toggle('active', mode === 'series');

      // Update top bar title and placeholders
      const titleEl = document.getElementById('content-mode-title');
      const searchInput = document.getElementById('live-channel-search');
      const catSearchInput = document.getElementById('cat-filter-input');

      if (mode === 'live') {
        titleEl.textContent = 'مباشر';
        searchInput.placeholder = 'البحث في القنوات...';
        catSearchInput.placeholder = 'البحث في فئات القنوات...';
        currentActiveCategory = 'all';
        currentSelectedItem = liveChannels[0] || null;
      } else if (mode === 'movies') {
        titleEl.textContent = 'الأفلام (VOD)';
        searchInput.placeholder = 'البحث في الأفلام...';
        catSearchInput.placeholder = 'البحث في تصنيفات الأفلام...';
        currentActiveCategory = 'all';
        currentSelectedItem = movies[0] || null;
      } else if (mode === 'series') {
        titleEl.textContent = 'المسلسلات (Series)';
        searchInput.placeholder = 'البحث في المسلسلات...';
        catSearchInput.placeholder = 'البحث في تصنيفات المسلسلات...';
        currentActiveCategory = 'all';
        currentSelectedItem = series[0] || null;
      }

      if (sonixSettings.rememberSection) {
        try {
          const savedCategory = localStorage.getItem('sonix_last_category_' + mode);
          if (savedCategory && getActiveCategoryList().some(category => category.id === savedCategory)) currentActiveCategory = savedCategory;
        } catch (_) {}
      }
      if (sonixSettings.rememberItem) {
        try {
          const savedId = localStorage.getItem('sonix_last_item_' + mode);
          const remembered = getActiveItemList().find(item => String(item.id) === String(savedId));
          if (remembered) currentSelectedItem = {...remembered, streamUrl:''};
        } catch (_) {}
      }

      renderCategories();
      renderItems();
      if (currentSelectedItem && currentSelectedItem.streamUrl) videoPlaybackController.loadItem(currentSelectedItem);
    }

    function getActiveCategoryList() {
      if (currentAppMode === 'movies') return movieCategories;
      if (currentAppMode === 'series') return seriesCategories;
      return liveCategories;
    }

    function getActiveItemList() {
      if (currentAppMode === 'movies') return movies;
      if (currentAppMode === 'series') return series;
      return liveChannels;
    }

    function renderCategories() {
      const container = document.getElementById('categories-list-container');
      if (!container) return;
      container.innerHTML = '';

      const categories = getActiveCategoryList();
      const allItems = getActiveItemList();
      const categoryCounts = new Map();
      let favoritesCount = 0;
      allItems.forEach(entry => {
        if (entry.category) categoryCounts.set(entry.category, (categoryCounts.get(entry.category) || 0) + 1);
        if (isFavorite(entry.id)) favoritesCount++;
      });

      categories.forEach(cat => {
        const item = document.createElement('div');
        item.className = `category-item focusable ${cat.id === currentActiveCategory ? 'selected' : ''}`;
        item.tabIndex = 0;
        item.dataset.catId = cat.id;

        const count = cat.id === 'all' ? allItems.length
          : cat.id === 'favorites' ? favoritesCount
          : (categoryCounts.get(cat.id) || 0);
        const name = document.createElement('span');
        name.textContent = cat.name || 'تصنيف';
        const badge = document.createElement('span');
        badge.className = 'category-badge';
        badge.textContent = String(count);
        item.append(name, badge);

        item.addEventListener('click', () => {
          selectCategory(cat.id);
        });

        container.appendChild(item);
      });
    }

    function selectCategory(catId) {
      currentActiveCategory = catId;
      if (sonixSettings.rememberSection) {
        try { localStorage.setItem('sonix_last_category_' + currentAppMode, catId); } catch (_) {}
      }
      document.querySelectorAll('.category-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.catId === catId);
      });

      const categories = getActiveCategoryList();
      const catObj = categories.find(c => c.id === catId);
      if (catObj) {
        document.getElementById('channels-badge-name').textContent = catObj.name;
      }

      renderItems();
    }

    function renderItems(filterText = '') {
      const container = document.getElementById('channels-list-container');
      if (!container) return;
      container.classList.toggle('media-grid', currentAppMode === 'movies' || currentAppMode === 'series');
      channelRenderGeneration++;
      container.innerHTML = '';
      currentRenderedItems = [];
      currentRenderedCount = 0;
      const allItems = getActiveItemList();
      const normalizedFilter = String(filterText || '').trim().toLowerCase();
      let items;
      if (currentActiveCategory === 'all') items = allItems;
      else if (currentActiveCategory === 'favorites') items = allItems.filter(item => isFavorite(item.id));
      else items = allItems.filter(item => item.category === currentActiveCategory);
      if (currentActiveCategory === 'all' && sonixSettings.favoritesFirst) {
        items = items.slice().sort((a,b) => Number(isFavorite(b.id)) - Number(isFavorite(a.id)));
      }
      if (normalizedFilter) items = items.filter(item => String(item.name || '').toLowerCase().includes(normalizedFilter));
      const countSuffix = currentAppMode === 'movies' ? 'فيلم' : (currentAppMode === 'series' ? 'مسلسل' : 'قناة');
      document.getElementById('channels-badge-count').textContent = `${items.length} ${countSuffix}`;
      if (!items.length) {
        container.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding:24px; font-size:0.85rem;">لا توجد عناصر متاحة في هذا التصنيف</div>`;
        return;
      }
      currentRenderedItems = items;
      if (!container.dataset.incrementalScrollBound) {
        container.addEventListener('scroll', () => {
          const remainingScroll = container.scrollHeight - container.clientHeight - container.scrollTop;
          if (remainingScroll <= CHANNEL_RENDER_PREFETCH_PX) loadMoreChannelRows();
        }, { passive: true });
        container.dataset.incrementalScrollBound = 'true';
      }
      // Render only the first batch. Further batches are requested by actual
      // scrolling or by DPAD navigation at the end of the rendered rows.
      appendChannelRows();
    }

    function loadLiveEpg(item) {
      if (!item || !window.XtreamBridge) return;
      item.epgTitle = '';
      item.epgDesc = '';
      item.epgNext = '';
      const currentTitle = document.getElementById('epg-curr-title');
      const currentDesc = document.getElementById('epg-curr-desc');
      const nextTitle = document.getElementById('epg-next-title');
      if (currentSelectedItem && currentSelectedItem.id === item.id) {
        if (currentTitle) currentTitle.textContent = 'جارٍ تحميل دليل البرامج...';
        if (currentDesc) currentDesc.textContent = 'يرجى الانتظار';
        if (nextTitle) nextTitle.textContent = 'لا توجد بيانات بعد';
      }
      try {
        const response=parseNative(window.XtreamBridge.shortEpg(item.id));
        const listings=response.epg_listings || [];
        if (!listings.length) {
          if (currentSelectedItem && currentSelectedItem.id === item.id) {
            if (currentTitle) currentTitle.textContent = 'لا تتوفر بيانات EPG لهذه القناة';
            if (currentDesc) currentDesc.textContent = 'لم يرسل الخادم جدول برامج';
            if (nextTitle) nextTitle.textContent = 'لا توجد بيانات للبرنامج التالي';
          }
          return;
        }
        const decodeText=value => {
          try { return decodeURIComponent(escape(atob(value || ''))); } catch (_) { return value || ''; }
        };
        const current=listings[0], next=listings[1];
        item.epgTitle=decodeText(current.title);
        item.epgDesc=decodeText(current.description);
        item.epgNext=next ? decodeText(next.title) : '';
        if(currentSelectedItem && currentSelectedItem.id === item.id) {
          document.getElementById('epg-curr-title').textContent=item.epgTitle || 'بث مباشر';
          document.getElementById('epg-curr-desc').textContent=item.epgDesc || 'لا توجد تفاصيل إضافية';
          document.getElementById('epg-next-title').textContent=item.epgNext || 'لا توجد بيانات للبرنامج التالي';
        }
      } catch(error) {
        console.warn('EPG unavailable',error);
        if (currentSelectedItem && currentSelectedItem.id === item.id) {
          if (currentTitle) currentTitle.textContent = 'تعذر تحميل دليل البرامج';
          if (currentDesc) currentDesc.textContent = error.message || 'الخادم لم يوفر بيانات EPG';
          if (nextTitle) nextTitle.textContent = 'لا توجد بيانات للبرنامج التالي';
        }
      }
    }
    function selectItem(item) {
      currentSelectedItem = item;
      if (sonixSettings.rememberItem) {
        try { localStorage.setItem('sonix_last_item_' + currentAppMode, String(item.id)); } catch (_) {}
      }
      document.querySelectorAll('.channel-row').forEach(el => {
        el.classList.toggle('selected', el.dataset.itemId === item.id);
      });

      if (currentAppMode === 'series' && item.seriesId) { openSeriesEpisodes(item); return; }
      if (currentAppMode === 'live' && !item.streamUrl) {
        item.streamDescriptor = { type: 'live', id: String(item.id), ext: item.containerExtension || 'ts' }; item.streamUrl = 'native://stream';
      }
      if (currentAppMode === 'movies') {
        // The VOD catalogue already contains the stream extension and basic
        // metadata. Do not make a synchronous get_vod_info HTTP request here:
        // it blocks selection and delays playback before ExoPlayer even starts.
        if (!item.streamUrl) {
          item.streamDescriptor = { type: 'movie', id: String(item.id), ext: item.containerExtension || 'mp4' };
          item.streamUrl = 'native://stream';
        }
      }
      if (!item.streamUrl) { showToast('رابط التشغيل غير متوفر من الخادم'); return; }
      videoPlaybackController.loadItem(item);
      if (currentAppMode === 'live') loadLiveEpg(item);
    }

    function classifyAudioSource(name, categoryName, categoryId) {
      const searchable = (String(name || '') + ' ' + String(categoryName || '') + ' ' + String(categoryId || '')).toLowerCase().replace(/[\u064B-\u065F\u0670]/g, '').replace(/[أإآ]/g, 'ا').replace(/[^a-z0-9\u0600-\u06FF]+/g, ' ').trim();
      const bein = ['bein sports','bein sport','beinsports','beinsport','be in sports','be in sport','بي ان سبورت','بي ان','بين سبورت'].some(term => searchable.includes(term));
      if (bein) return 'BEIN SPORTS'; if (/\b(alwan|al wan)\b/.test(searchable) || searchable.includes('الوان')) return 'ALWAN'; return '';
    }
    function renderAudioSourcePicker(filterText = '') {
      const container = document.getElementById('audio-channels-list'); if (!container) return; container.replaceChildren();
      const query = String(filterText || '').trim().toLowerCase();
      const available = liveChannels.filter(ch => classifyAudioSource(ch.name, ch.categoryName, ch.category))
        .filter(ch => !videoPlaybackController || !videoPlaybackController.currentItem || String(ch.id) !== String(videoPlaybackController.currentItem.id))
        .filter(ch => !query || String(ch.name || '').toLowerCase().includes(query) || String(ch.categoryName || '').toLowerCase().includes(query));
      const groups = [{name:'beIN SPORTS',items:available.filter(ch => classifyAudioSource(ch.name,ch.categoryName,ch.category)==='BEIN SPORTS')},{name:'ALWAN',items:available.filter(ch => classifyAudioSource(ch.name,ch.categoryName,ch.category)==='ALWAN')}];
      let count = 0; groups.forEach(group => { if (!group.items.length) return;
        const header = document.createElement('div'); header.style.cssText = 'padding:8px 4px 5px;color:var(--accent-gold);font-weight:800;font-size:0.8rem;'; header.textContent = group.name + ' (' + group.items.length + ')'; container.appendChild(header);
        group.items.forEach(ch => { const item = document.createElement('div'); const selected = dualAudioEngine && dualAudioEngine.selectedSourceChannel && String(dualAudioEngine.selectedSourceChannel.id)===String(ch.id);
          item.className = 'audio-picker-item focusable' + (selected ? ' active' : ''); item.tabIndex = 0; item.dataset.channelId = String(ch.id);
          const name = document.createElement('span'); name.textContent = String(ch.number || '') + '. ' + String(ch.name || '');
          const category = document.createElement('span'); category.style.cssText = 'font-size:0.7rem;color:var(--text-muted);'; category.textContent = ch.categoryName || '';
          item.append(name,category); item.addEventListener('click',()=>dualAudioEngine.setSourceChannel(ch)); container.appendChild(item); count++;
        });
      });
      if (!count) { const empty = document.createElement('div'); empty.className = 'audio-picker-item'; empty.textContent = 'لا توجد مصادر صوت beIN SPORTS أو ALWAN في بيانات اشتراكك'; container.appendChild(empty); }
    }
    function updateFavoriteButtons(itemId) {
      const isFav = isFavorite(itemId);
      const favLabel = document.getElementById('fav-btn-label');
      const previewFavorite = document.getElementById('btn-toggle-fav');
      const playbackFavorite = document.getElementById('btn-playback-fav');
      if (previewFavorite) previewFavorite.classList.toggle('active', isFav);
      if (playbackFavorite) playbackFavorite.classList.toggle('active', isFav);
      if (favLabel) favLabel.textContent = isFav ? 'في المفضلة' : 'إضافة للمفضلة';
    }

    function toggleFavorite(itemId) {
      if (!itemId) return;
      const key = favoriteKey(itemId);
      if (memoryFavorites.has(key)) {
        memoryFavorites.delete(key);
        showToast('تمت الإزالة من المفضلة');
      } else {
        memoryFavorites.add(key);
        showToast('تمت الإضافة إلى المفضلة');
      }
      saveFavorites();
      updateFavoriteButtons(itemId);
      renderCategories();
      renderItems();
    }

    /**
     * =========================================================================
     * INITIALIZATION & LIFECYCLE
     * =========================================================================
     */
    let videoPlaybackController;
    let dualAudioEngine;
    let remoteNavigator;

    window.onNativePlaybackBuffering = function(message) { if (videoPlaybackController) videoPlaybackController.showLoader(message || 'جارٍ تخزين البث مؤقتاً...'); };
    window.onNativePlaybackReady = function() {
      if (videoPlaybackController) {
        videoPlaybackController.hideLoader();
        if (window.SonixSubtitles && window.SonixSubtitles.applyStyle) window.SonixSubtitles.applyStyle();
        const panel=document.querySelector('.live-player-col'); if(panel) panel.classList.add('has-active-playback');
      }
    };
    window.onNativePlaybackStateChanged = function(isPlaying) { if (videoPlaybackController) videoPlaybackController.updatePlaybackState(!!isPlaying); };
    window.onNativePlaybackProgress = function(positionMs, durationMs, seekable) {
      if (videoPlaybackController) videoPlaybackController.updateTimeline(positionMs, durationMs, !!seekable);
    };
    window.onNativePlaybackEnded = function() { if (videoPlaybackController) videoPlaybackController.updatePlaybackState(false); };
    window.onNativePlaybackError = function(message) {
      const panel=document.querySelector('.live-player-col'); if(panel) panel.classList.remove('has-active-playback');
      if (videoPlaybackController) videoPlaybackController.showError(message || 'فشل تشغيل البث');
    };

    document.addEventListener('DOMContentLoaded', () => {
      const syncNativeTextFocus = () => {
        const active = document.activeElement;
        const editing = !!(active &&
          (active.matches('input, textarea, select') || active.isContentEditable));
        if (window.AndroidBridge && typeof window.AndroidBridge.setTextInputFocused === 'function') {
          window.AndroidBridge.setTextInputFocused(editing);
        }
      };
      document.addEventListener('focusin', syncNativeTextFocus, true);
      document.addEventListener('focusout', () => window.setTimeout(syncNativeTextFocus, 0), true);

      document.getElementById('login-submit').addEventListener('click', () => performXtreamLogin(
        document.getElementById('login-server').value,
        document.getElementById('login-username').value,
        document.getElementById('login-password').value, false));
      ['login-server','login-username','login-password'].forEach(id => document.getElementById(id).addEventListener('keydown',e => {
        if(e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          document.getElementById('login-submit').click();
        }
      }));

      // Load persisted preferences before the playback controller is created.
      initializeSonixSettingsControls();

      // 1. Initialize Video & Audio Engines
      videoPlaybackController = new VideoPlaybackController();
      dualAudioEngine = new DualAudioSystem(videoPlaybackController);
      remoteNavigator = new RemoteControlNavigator();

      // 2. Setup Clock
      updateLiveClock();
      setInterval(updateLiveClock, 30000);

      // 3. Render initial content
      renderCategories();
      renderItems();
      renderAudioSourcePicker();

      // 4. Bind Home Screen Action Cards
      document.getElementById('card-channels').addEventListener('click', () => {
        switchView('view-live');
        // Always reset the preview when entering the Channels card from Home.
        if (window.NativePlayback && typeof window.NativePlayback.stop === 'function') {
          window.NativePlayback.stop();
        }
        if (videoPlaybackController) {
          videoPlaybackController.currentItem = null;
          videoPlaybackController.hidePlaybackControls();
        }
        const playerPanel = document.querySelector('.live-player-col');
        if (playerPanel) playerPanel.classList.remove('has-active-playback');
        setAppMode('live');
      });
      document.getElementById('card-movies').addEventListener('click', () => {
        switchView('view-live');
        setAppMode('movies');
      });
      document.getElementById('card-series').addEventListener('click', () => {
        switchView('view-live');
        setAppMode('series');
      });

      // 5. Explicit Back Button in Top Bar (Returns to Home!)
      document.getElementById('live-btn-back').addEventListener('click', () => {
        switchView('view-home');
      });

      // 6. Sidebar Mode Navigation (Unified 4-column layout)
      document.getElementById('side-nav-live').addEventListener('click', () => setAppMode('live'));
      document.getElementById('side-nav-movies').addEventListener('click', () => setAppMode('movies'));
      document.getElementById('side-nav-series').addEventListener('click', () => setAppMode('series'));
      document.getElementById('side-nav-history').addEventListener('click', () => openModal('modal-epg'));
      document.getElementById('side-nav-settings').addEventListener('click', () => openModal('modal-settings'));

      // 7. Home Top Bar Buttons
      document.getElementById('btn-power').addEventListener('click', () => openModal('modal-power'));
      document.getElementById('btn-refresh').addEventListener('click', refreshXtreamContent);
      document.getElementById('btn-profile').addEventListener('click', () => openModal('modal-profile'));
      document.getElementById('btn-settings').addEventListener('click', () => openModal('modal-settings'));
      document.getElementById('settings-refresh').addEventListener('click', () => {
        refreshXtreamContent();
      });
      document.getElementById('settings-account').addEventListener('click', () => {
        closeAllModals();
        openModal('modal-profile');
      });

      document.getElementById('btn-save-iptv').addEventListener('click', () => {
        const server=document.getElementById('iptv-server-url').value;
        const username=document.getElementById('iptv-username').value;
        const password=document.getElementById('iptv-password').value;
        document.getElementById('login-server').value=server;
        document.getElementById('login-username').value=username;
        document.getElementById('login-password').value=password;
        closeAllModals();
        document.getElementById('sonix-login-screen').classList.remove('hidden');
        const firstLoginField = document.getElementById('login-server');
        if (firstLoginField && remoteNavigator) remoteNavigator.focusElement(firstLoginField);
        performXtreamLogin(server,username,password,false);
      });
      document.getElementById('btn-search').addEventListener('click', () => openModal('modal-search'));

      // 8. Player Actions
      document.getElementById('btn-open-epg').addEventListener('click', () => {
        if (currentAppMode === 'live') {
          if (currentSelectedItem) loadLiveEpg(currentSelectedItem);
          openModal('modal-epg');
        } else {
          showToast(`جارٍ تشغيل ${currentSelectedItem ? currentSelectedItem.name : ''}...`);
        }
      });
      document.getElementById('btn-open-ext-audio').addEventListener('click', () => {
        renderAudioSourcePicker();
        openModal('modal-ext-audio');
      });
      document.getElementById('btn-toggle-fav').addEventListener('click', () => {
        if (currentSelectedItem) toggleFavorite(currentSelectedItem.id);
      });


      // 9. Modals Close Handlers
      document.getElementById('close-ext-audio').addEventListener('click', closeAllModals);
      document.getElementById('btn-ext-audio-done').addEventListener('click', closeAllModals);
      document.getElementById('close-epg').addEventListener('click', closeAllModals);
      document.getElementById('close-epg-footer').addEventListener('click', closeAllModals);
      document.getElementById('close-profile').addEventListener('click', closeAllModals);
      document.getElementById('close-profile-footer').addEventListener('click', closeAllModals);
      document.getElementById('close-settings').addEventListener('click', closeAllModals);
      document.getElementById('close-settings-footer').addEventListener('click', closeAllModals);
      document.getElementById('close-search').addEventListener('click', closeAllModals);
      document.getElementById('close-search-footer').addEventListener('click', closeAllModals);
      document.getElementById('close-power').addEventListener('click', closeAllModals);
      document.getElementById('btn-cancel-exit').addEventListener('click', closeAllModals);
      document.getElementById('btn-confirm-exit').addEventListener('click', () => {
        closeAllModals();
        videoPlaybackController.stopAndRelease();
        if (dualAudioEngine) dualAudioEngine.releaseAll();
        showToast('تم إغلاق الجلسة بنجاح');
        if (window.AndroidBridge && typeof window.AndroidBridge.closeApp === 'function') {
          window.AndroidBridge.closeApp();
        }
      });

      try {
        // Credentials are kept in the encrypted native vault and the last
        // successfully loaded catalogue is already persisted in WebView storage.
        // Restore the cached screen first; never block startup on provider HTTP calls.
        const saved=parseNative(window.XtreamBridge.savedCredentials());
        document.getElementById('login-server').value=saved.server || '';
        document.getElementById('login-username').value=saved.username || '';
        activeCredentials={server:saved.server,username:saved.username};
        isOfflineCache=restoreXtreamCache();
        const hasCompleteLocalCatalog=isOfflineCache;
        updateAccount({username:saved.username});
        document.getElementById('sonix-login-screen').classList.add('hidden');
        renderCategories();
        renderItems();
        renderAudioSourcePicker();
        const startupStatus=document.getElementById('profile-server-status');
        if(startupStatus) startupStatus.textContent=hasCompleteLocalCatalog
          ? 'تمت استعادة المحتوى المحفوظ محلياً'
          : 'جارٍ إكمال المزامنة الأولى للمحتوى...';
        // Only bootstrap when no complete local catalogue exists (e.g. first
        // launch after upgrading an older build). Normal launches are offline-only.
        if(!hasCompleteLocalCatalog) {
          setTimeout(() => {
            try {
              loadXtreamContent();
              if(startupStatus) startupStatus.textContent='تم تحميل المحتوى وحفظ المزامنة';
            } catch(error) {
              if(startupStatus) startupStatus.textContent='تعذر إكمال المزامنة الأولى';
              showToast('تعذر تحميل المحتوى: ' + (error.message || 'تحقق من اتصال الإنترنت'));
            }
          }, 350);
        }
      } catch (_) {
        activeCredentials=null;
        document.getElementById('sonix-login-screen').classList.remove('hidden');
        const firstLoginField = document.getElementById('login-server');
        if (firstLoginField && remoteNavigator) remoteNavigator.focusElement(firstLoginField);
      }

      // 10. Search Filters
      document.getElementById('cat-filter-input').addEventListener('input', (e) => {
        const val = e.target.value.trim().toLowerCase();
        document.querySelectorAll('.category-item').forEach(item => {
          const text = item.textContent.toLowerCase();
          item.style.display = text.includes(val) ? 'flex' : 'none';
        });
      });

      document.getElementById('live-channel-search').addEventListener('input', (e) => {
        renderItems(e.target.value.trim());
      });

      document.getElementById('audio-src-filter').addEventListener('input', (e) => {
        renderAudioSourcePicker(e.target.value.trim());
      });

      // 11. Global Search
      document.getElementById('global-search-input').addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        const resultsContainer = document.getElementById('global-search-results');
        resultsContainer.textContent = '';

        if (!query) {
          const msg = document.createElement('div');
          msg.style.cssText = 'text-align:center; color:var(--text-muted); padding:20px; font-size:0.85rem;';
          msg.textContent = 'ابدأ بالكتابة للبحث الفوري...';
          resultsContainer.appendChild(msg);
          return;
        }

        const matchedChannels = liveChannels.filter(c => (c.name || '').toLowerCase().includes(query));
        const matchedMovies = movies.filter(m => (m.name || '').toLowerCase().includes(query));
        const matchedSeries = series.filter(s => (s.name || '').toLowerCase().includes(query));

        if (!matchedChannels.length && !matchedMovies.length && !matchedSeries.length) {
          const empty = document.createElement('div');
          empty.style.cssText = 'text-align:center; color:var(--text-muted); padding:20px;';
          empty.textContent = 'لم يتم العثور على أي نتائج';
          resultsContainer.appendChild(empty);
          return;
        }

        const createSearchCard = (item, type, icon, badgeText, badgeColor) => {
          const card = document.createElement('div');
          card.className = 'audio-picker-item focusable';
          card.style.background = '#0A0F14';
          card.tabIndex = 0;

          const titleSpan = document.createElement('span');
          titleSpan.style.cssText = 'color:#fff; font-weight:700;';
          titleSpan.textContent = icon + ' ' + (item.name || '');

          const badgeSpan = document.createElement('span');
          badgeSpan.style.cssText = 'color:' + badgeColor + '; font-size:0.75rem;';
          badgeSpan.textContent = badgeText;

          card.append(titleSpan, badgeSpan);

          card.addEventListener('click', () => {
            closeAllModals();
            switchView('view-live');
            setAppMode(type);
            selectItem(item);
          });
          return card;
        };

        matchedChannels.forEach(c => {
          resultsContainer.appendChild(createSearchCard(c, 'live', '📺', 'قناة مباشرة', 'var(--focus-blue)'));
        });
        matchedMovies.forEach(m => {
          const ratingText = m.rating ? ' ★ ' + m.rating : '';
          resultsContainer.appendChild(createSearchCard(m, 'movies', '🎬', 'فيلم' + ratingText, 'var(--accent-gold)'));
        });
        matchedSeries.forEach(s => {
          const ratingText = s.rating ? ' ★ ' + s.rating : '';
          resultsContainer.appendChild(createSearchCard(s, 'series', '🍿', 'مسلسل' + ratingText, 'var(--focus-blue)'));
        });
      });

      // 12. Focus Channels Card Initially
      const initialFocus = document.getElementById('login-server') || document.getElementById('card-channels');
      if (initialFocus && remoteNavigator) {
        remoteNavigator.focusElement(initialFocus);
      }
    });