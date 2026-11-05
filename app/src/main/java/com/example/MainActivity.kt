package com.example

import android.annotation.SuppressLint
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.view.Gravity
import android.view.WindowManager
import android.graphics.Color
import android.graphics.Outline
import android.graphics.drawable.Drawable
import android.graphics.Shader
import android.graphics.RadialGradient
import android.graphics.PixelFormat
import android.graphics.Paint
import android.graphics.LinearGradient
import android.graphics.ColorFilter
import android.graphics.Canvas
import android.net.Uri
import android.content.Intent
import android.graphics.Typeface
import android.util.TypedValue
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import android.view.ViewGroup
import android.view.LayoutInflater
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.media3.ui.CaptionStyleCompat
import android.widget.FrameLayout
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.Format
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.datasource.DefaultHttpDataSource
import kotlin.math.roundToInt
import org.json.JSONObject
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.ViewCompat

@OptIn(UnstableApi::class)
class MainActivity : ComponentActivity() {

    private var webView: WebView? = null
    private var rootContainer: FrameLayout? = null
    private var nativePlayer: ExoPlayer? = null
    private var nativePlayerView: PlayerView? = null
    private var nativeVideoStreamType: String? = null
    private var nativeVideoStreamId: String? = null
    private val playbackRecoveryHandler = Handler(Looper.getMainLooper())
    private var playbackRequestStartedAtMs = 0L
    private var bufferingStartedAtMs = 0L
    private var hasPlaybackReachedReady = false
    private var firstFrameLogged = false
    private var liveRecoveryAttempts = 0
    private var playbackWatchdogRunnable: Runnable? = null
    private var liveRecoveryRunnable: Runnable? = null
    private var nativePlayerCornerRadiusPx = 0f
    @Volatile private var immersiveVideoFullscreen = false
    private var activeMediaUri: Uri? = null
    private var activeSubtitleFile: File? = null
    private val subtitleTypefaceCache = mutableMapOf<String, Typeface>()
    private val subtitleIoExecutor = Executors.newFixedThreadPool(3)
    private val codecDiagnosticsExecutor = Executors.newSingleThreadExecutor()
    private var lastUhdCodecDiagnosticKey: String? = null
    private val subtitleGeneration = AtomicLong(0)
    private val subtitleActivationHandler = Handler(Looper.getMainLooper())
    private val playbackProgressHandler = Handler(Looper.getMainLooper())
    private val playbackProgressRunnable = object : Runnable {
        override fun run() {
            val player = nativePlayer
            if (player != null && nativePlayerActive) {
                val rawDuration = player.duration
                val duration = if (rawDuration == C.TIME_UNSET || rawDuration <= 0L) -1L else rawDuration
                val position = player.currentPosition.coerceAtLeast(0L)
                val seekable = player.isCurrentMediaItemSeekable && duration > 0L
                webView?.evaluateJavascript(
                    "window.onNativePlaybackProgress && window.onNativePlaybackProgress($position, $duration, $seekable)",
                    null
                )
                playbackProgressHandler.postDelayed(this, 500L)
            }
        }
    }
    private var subtitleActivationTimeout: Runnable? = null
    private var pendingSubtitleRequestId: String? = null
    private var pendingSubtitleLabel = ""
    private var pendingSubtitleNotifyLocal = false
    private var subtitlePickerGeneration = 0L
    private val subtitlePickerRequestCode = 7412
    private var resumeNativePlayerAfterPause = false
    @Volatile private var nativePlayerActive = false
    @Volatile private var nativePlayerPlaying = false
    private var secondaryAudioPlayer: ExoPlayer? = null
    private val externalAudioHandler = Handler(Looper.getMainLooper())
    private var externalAudioRetryRunnable: Runnable? = null
    private var externalAudioRetryAttempt = 0
    private var externalAudioGeneration = 0L
    private var externalAudioSourceUrl = ""
    @Volatile private var externalAudioActive = false
    private var externalAudioSyncOffsetMs = 0L
    private var externalAudioVolume = 1f
    private var nativeVideoVolumeBeforeExternalAudio = 1f
    private var nativeVideoMuted = false
    private lateinit var xtreamBridge: XtreamBridge
    @Volatile private var webTextInputFocused = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Keep screen awake during playback
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        try {
            xtreamBridge = XtreamBridge(this)
            val wv = WebView(this).apply {
                isFocusable = true
                isFocusableInTouchMode = true
                setBackgroundColor(Color.TRANSPARENT)

                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    mediaPlaybackRequiresUserGesture = false
                    // Secure defaults: restrict arbitrary local file access from web contents.
                    // Assets loaded via file:///android_asset/ work reliably with default settings.
                    allowFileAccess = false
                    allowContentAccess = false
                    loadWithOverviewMode = true
                    useWideViewPort = true
                    builtInZoomControls = false
                    displayZoomControls = false
                    cacheMode = WebSettings.LOAD_DEFAULT
                    // IPTV video playback is handled natively by ExoPlayer rather than WebView media elements,
                    // so mixed content inside WebView is restricted to standard compatibility mode.
                    mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                }

                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                        return false
                    }
                }

                webChromeClient = object : WebChromeClient() {
                    override fun onPermissionRequest(request: PermissionRequest?) {
                        request?.grant(request.resources)
                    }
                }

                addJavascriptInterface(WebAppInterface(this@MainActivity), "AndroidBridge")
                addJavascriptInterface(xtreamBridge, "XtreamBridge")
                addJavascriptInterface(NativePlaybackBridge(), "NativePlayback")
            }

            webView = wv
            val root = FrameLayout(this).apply {
                background = SonixBackgroundDrawable()
                // Keep the native video child clipped to the application window.
                clipChildren = true
                clipToPadding = true
            }
            root.addView(wv, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            ))
            rootContainer = root
            setContentView(root)

            // Let the IME consume the first Back action while it is visible.
            // Only route Back into the web app after text editing has ended.
            onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    dispatchNativeBack()
                }
            })

            // Load the standalone SONIX TV interface
            wv.loadUrl("file:///android_asset/sonix_tv.html")
        } catch (e: Exception) {
            android.util.Log.e("SONIXPlayback", "Error initializing MainActivity", e)
        }
    }

    private inner class NativePlaybackBridge {
        @android.webkit.JavascriptInterface
        fun playStream(type: String, streamId: String, extension: String, left: Float, top: Float, width: Float, height: Float, pixelRatio: Float, cornerRadiusCssPx: Float) {
            runOnUiThread {
                try {
                    val mediaUri = xtreamBridge.buildPlaybackUri(type, streamId, extension)
                    startPlaybackInternal(mediaUri, left, top, width, height, pixelRatio, cornerRadiusCssPx, type, streamId.trim())
                } catch (error: Exception) {
                    stopNativePlayer()
                    val message = JSONObject.quote(error.message ?: "تعذر تجهيز رابط البث من الاشتراك")
                    webView?.evaluateJavascript(
                        "window.onNativePlaybackError && window.onNativePlaybackError(" + message + ")", null)
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun play(url: String, left: Float, top: Float, width: Float, height: Float, pixelRatio: Float, cornerRadiusCssPx: Float) {
            runOnUiThread {
                try {
                    val mediaUri = Uri.parse(url.trim())
                    require((mediaUri.scheme == "http" || mediaUri.scheme == "https") && !mediaUri.host.isNullOrBlank()) {
                        "رابط البث غير صالح"
                    }
                    startPlaybackInternal(mediaUri, left, top, width, height, pixelRatio, cornerRadiusCssPx, null, null)
                } catch (error: Exception) {
                    stopNativePlayer()
                    val message = JSONObject.quote(error.message ?: "تعذر تشغيل البث")
                    webView?.evaluateJavascript(
                        "window.onNativePlaybackError && window.onNativePlaybackError(" + message + ")", null)
                }
            }
        }

        private fun startPlaybackInternal(
            mediaUri: Uri,
            left: Float,
            top: Float,
            width: Float,
            height: Float,
            pixelRatio: Float,
            cornerRadiusCssPx: Float,
            streamType: String?,
            streamId: String?
        ) {
            // Keep one ExoPlayer and one TextureView-backed PlayerView alive across
            // item changes. Explicit stop/release requests still use stopNativePlayer().
            resetNativePlayerForNextItem()
            nativeVideoStreamType = streamType
            nativeVideoStreamId = streamId
            playbackRequestStartedAtMs = SystemClock.elapsedRealtime()
            bufferingStartedAtMs = 0L
            hasPlaybackReachedReady = false
            firstFrameLogged = false
            liveRecoveryAttempts = 0

            val container = rootContainer ?: throw IllegalStateException("واجهة المشغل غير جاهزة")
            nativePlayerCornerRadiusPx = cssPixelsToAndroidPixels(cornerRadiusCssPx.coerceIn(0f, 32f), pixelRatio).toFloat()
            val params = calculatePlayerLayoutParams(left, top, width, height, pixelRatio, container, webView)
                ?: throw IllegalStateException("مساحة معاينة الفيديو غير صالحة")

            activeMediaUri = mediaUri
            activeSubtitleFile = null

            val player = nativePlayer ?: run {
                val httpDataSourceFactory = DefaultHttpDataSource.Factory()
                    .setUserAgent("SONIX-TV/1.0")
                    .setAllowCrossProtocolRedirects(true)
                    .setConnectTimeoutMs(15000)
                    .setReadTimeoutMs(10000)
                val mediaSourceFactory = DefaultMediaSourceFactory(httpDataSourceFactory)
                // Match Night's proven live-IPTV buffering profile to better absorb
                // short network jitter, including when external audio is also active.
                val videoLoadControl = DefaultLoadControl.Builder()
                    .setBufferDurationsMs(
                        3000,   // keep a modest safety buffer for IPTV streams
                        20000,  // cap buffered media to limit memory use
                        1000,   // start as soon as one second is buffered
                        2000    // recover faster after a brief network interruption
                    )
                    .build()
                ExoPlayer.Builder(this@MainActivity)
                    .setLoadControl(videoLoadControl)
                    .setMediaSourceFactory(mediaSourceFactory)
                    .build()
                    .also { created ->
                        nativePlayer = created
                        attachNativePlayerListeners(created)
                    }
            }

            // PlayerView owns the video output surface for its complete lifecycle.
            // TextureView is selected because it composes beneath the transparent
            // WebView, allowing the existing HTML controls to remain interactive.
            val playerView = nativePlayerView ?: (
                LayoutInflater.from(this@MainActivity)
                    .inflate(R.layout.native_player_view, container, false) as PlayerView
                ).also { nativePlayerView = it }
            playerView.apply {
                setUseController(false)
                setResizeMode(if (immersiveVideoFullscreen) AspectRatioFrameLayout.RESIZE_MODE_ZOOM else AspectRatioFrameLayout.RESIZE_MODE_FIT)
                setKeepContentOnPlayerReset(true)
                setShutterBackgroundColor(Color.TRANSPARENT)
                setBackgroundColor(Color.TRANSPARENT)
                clipChildren = true
                clipToPadding = true
                // PlayerView is a native sibling of the WebView, so CSS overflow
                // cannot clip it. Apply the preview's rounded clipping natively.
                clipToOutline = true
                outlineProvider = object : ViewOutlineProvider() {
                    override fun getOutline(view: View, outline: Outline) {
                        outline.setRoundRect(
                            0, 0, view.width, view.height,
                            nativePlayerCornerRadiusPx.coerceAtLeast(0f)
                        )
                    }
                }
                isFocusable = false
                isFocusableInTouchMode = false
                invalidateOutline()
            }

            nativePlayerActive = true
            nativePlayerPlaying = false
            player.volume = if (externalAudioActive || nativeVideoMuted) 0f else 1f
            // A reused player must not carry a previous item's forced track override.
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                .clearOverridesOfType(C.TRACK_TYPE_VIDEO)
                .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .setMaxVideoSize(Int.MAX_VALUE, Int.MAX_VALUE)
                .build()

            // Use an explicit physical LEFT gravity: START would resolve to RIGHT in RTL
            // layouts and can place the native layer outside the HTML viewport.
            params.gravity = Gravity.TOP or Gravity.LEFT
            if (playerView.parent === container) {
                playerView.layoutParams = params
            } else {
                (playerView.parent as? ViewGroup)?.removeView(playerView)
                container.addView(playerView, 0, params)
            }
            playerView.player = player

            val extension = mediaUri.lastPathSegment
                ?.substringAfterLast('.', "")
                ?.lowercase()
                .orEmpty()
            val mimeType = when (extension) {
                "m3u8" -> MimeTypes.APPLICATION_M3U8
                "mpd" -> MimeTypes.APPLICATION_MPD
                else -> null
            }
            val mediaItem = MediaItem.Builder()
                .setUri(mediaUri)
                .apply { if (mimeType != null) setMimeType(mimeType) }
                .build()
            player.setMediaItem(mediaItem)
            player.prepare()
            player.playWhenReady = true
            android.util.Log.i("SONIXPlayback", "prepare() issued streamType=" + (nativeVideoStreamType ?: "url") + " elapsed=" + (SystemClock.elapsedRealtime() - playbackRequestStartedAtMs) + "ms")
            playbackProgressHandler.removeCallbacks(playbackProgressRunnable)
            playbackProgressHandler.post(playbackProgressRunnable)
        }

        private fun attachNativePlayerListeners(player: ExoPlayer) {
            player.addListener(object : Player.Listener {
                override fun onTracksChanged(tracks: Tracks) {
                    if (activeSubtitleFile == null || pendingSubtitleLabel.isBlank()) return
                    val playerNow = nativePlayer ?: return
                    val expectedLabel = activeSubtitleFile?.nameWithoutExtension ?: return
                    val candidate = tracks.groups.firstNotNullOfOrNull { group ->
                        if (group.type != C.TRACK_TYPE_TEXT) return@firstNotNullOfOrNull null
                        val index = (0 until group.length).firstOrNull { index ->
                            group.isTrackSupported(index) &&
                                group.getTrackFormat(index).label?.equals(expectedLabel, ignoreCase = true) == true
                        } ?: return@firstNotNullOfOrNull null
                        group to index
                    } ?: return
                    val (group, trackIndex) = candidate
                    if (!group.isTrackSelected(trackIndex)) {
                        playerNow.trackSelectionParameters = playerNow.trackSelectionParameters.buildUpon()
                            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                            .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                            .addOverride(TrackSelectionOverride(group.mediaTrackGroup, listOf(trackIndex)))
                            .build()
                        return
                    }
                    finishSubtitleActivation(true, "")
                }

                override fun onPlaybackStateChanged(playbackState: Int) {
                    when (playbackState) {
                        Player.STATE_BUFFERING -> {
                            if (bufferingStartedAtMs == 0L) {
                                bufferingStartedAtMs = SystemClock.elapsedRealtime()
                                android.util.Log.i("SONIXPlayback", "STATE_BUFFERING streamType=" + (nativeVideoStreamType ?: "url"))
                            }
                            startPlaybackWatchdog(player)
                            webView?.evaluateJavascript(
                                "window.onNativePlaybackBuffering && window.onNativePlaybackBuffering()", null)
                        }
                        Player.STATE_READY -> {
                            playbackWatchdogRunnable?.let(playbackRecoveryHandler::removeCallbacks)
                            playbackWatchdogRunnable = null
                            val now = SystemClock.elapsedRealtime()
                            if (bufferingStartedAtMs > 0L) {
                                android.util.Log.i("SONIXPlayback", "STATE_READY after " + (now - bufferingStartedAtMs) + "ms buffering; requestElapsed=" + (now - playbackRequestStartedAtMs) + "ms")
                            }
                            bufferingStartedAtMs = 0L
                            hasPlaybackReachedReady = true
                            liveRecoveryAttempts = 0
                            liveRecoveryRunnable?.let(playbackRecoveryHandler::removeCallbacks)
                            liveRecoveryRunnable = null
                            webView?.evaluateJavascript(
                                "window.onNativePlaybackReady && window.onNativePlaybackReady()", null)
                        }
                        Player.STATE_ENDED -> {
                            playbackWatchdogRunnable?.let(playbackRecoveryHandler::removeCallbacks)
                            playbackWatchdogRunnable = null
                            webView?.evaluateJavascript(
                                "window.onNativePlaybackEnded && window.onNativePlaybackEnded()", null)
                        }
                    }
                }

                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    nativePlayerPlaying = isPlaying
                    webView?.evaluateJavascript(
                        "window.onNativePlaybackStateChanged && window.onNativePlaybackStateChanged(" + isPlaying + ")", null)
                }

                override fun onPlayerError(error: PlaybackException) {
                    val detail = buildString {
                        append("خطأ المشغل: ")
                        append(error.errorCodeName)
                        error.message?.takeIf { it.isNotBlank() }?.let {
                            append(" — ")
                            append(it)
                        }
                    }
                    android.util.Log.e("SONIXPlayback", "Playback failed: " + error.errorCodeName, error)
                    if (nativeVideoStreamType == "live") {
                        scheduleLiveRecovery(player, detail)
                    } else {
                        stopNativePlayer()
                        notifyNativePlaybackError(detail)
                    }
                }
            })

            player.addAnalyticsListener(object : AnalyticsListener {
                override fun onRenderedFirstFrame(eventTime: AnalyticsListener.EventTime, output: Any, renderTimeMs: Long) {
                    if (!firstFrameLogged) {
                        firstFrameLogged = true
                        android.util.Log.i("SONIXPlayback", "FIRST_FRAME elapsed=" + (SystemClock.elapsedRealtime() - playbackRequestStartedAtMs) + "ms streamType=" + (nativeVideoStreamType ?: "url"))
                    }
                }

                override fun onDroppedVideoFrames(eventTime: AnalyticsListener.EventTime, droppedFrames: Int, elapsedMs: Long) {
                    if (droppedFrames > 0) {
                        android.util.Log.w("SONIXPlayback", "Dropped " + droppedFrames + " video frames in " + elapsedMs + "ms")
                    }
                }

                override fun onVideoDecoderInitialized(eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) {
                    android.util.Log.i("SONIXPlayback", "VIDEO_DECODER name=" + decoderName + " init=" + initializationDurationMs + "ms")
                }

                override fun onVideoInputFormatChanged(eventTime: AnalyticsListener.EventTime, format: Format, decoderReuseEvaluation: androidx.media3.exoplayer.DecoderReuseEvaluation?) {
                    android.util.Log.i("SONIXPlayback", "VIDEO_FORMAT mime=" + format.sampleMimeType + " size=" + format.width + "x" + format.height + " fps=" + format.frameRate + " bitrate=" + format.bitrate)
                    if (format.width >= 3840 || format.height >= 2160) {
                        val key = (format.sampleMimeType ?: "unknown") + ":" + format.width + "x" + format.height + ":" + format.frameRate
                        if (lastUhdCodecDiagnosticKey != key) {
                            lastUhdCodecDiagnosticKey = key
                            codecDiagnosticsExecutor.execute { inspectUhdCodecCapabilities(format) }
                        }
                    }
                }
            })
        }

        @android.webkit.JavascriptInterface
        fun setFullscreen(enabled: Boolean) {
            runOnUiThread {
                immersiveVideoFullscreen = enabled
                applyVideoFullscreenSystemUi()
                nativePlayerView?.resizeMode = if (enabled) {
                    // Fill ultrawide phone displays in fullscreen; restore the full frame in preview.
                    AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                } else {
                    AspectRatioFrameLayout.RESIZE_MODE_FIT
                }
                // System-bar visibility changes resize the WebView asynchronously. Re-read
                // its final viewport after the inset/layout pass and realign the native surface.
                webView?.postDelayed({
                    webView?.evaluateJavascript(
                        "(function(){if(window.videoPlaybackController){window.videoPlaybackController.syncNativeBounds();}})()",
                        null
                    )
                }, 250L)
            }
        }

        @android.webkit.JavascriptInterface
        fun stop() { runOnUiThread { stopNativePlayer() } }

        @android.webkit.JavascriptInterface
        fun toggle() {
            runOnUiThread {
                nativePlayer?.let {
                    if (it.isPlaying) {
                        it.pause()
                        secondaryAudioPlayer?.pause()
                    } else {
                        it.play()
                        if (externalAudioActive) secondaryAudioPlayer?.play()
                    }
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun isPlaying(): Boolean = nativePlayerPlaying

        @android.webkit.JavascriptInterface
        fun isActive(): Boolean = nativePlayerActive

        @android.webkit.JavascriptInterface
        fun pause() {
            runOnUiThread {
                nativePlayer?.pause()
                if (externalAudioActive) secondaryAudioPlayer?.pause()
            }
        }

        @android.webkit.JavascriptInterface
        fun resume() {
            runOnUiThread {
                nativePlayer?.play()
                if (externalAudioActive) secondaryAudioPlayer?.play()
            }
        }

        @android.webkit.JavascriptInterface
        fun setMuted(muted: Boolean) {
            runOnUiThread {
                nativeVideoMuted = muted
                nativePlayer?.volume = if (externalAudioActive || muted) 0f else 1f
            }
        }

        @android.webkit.JavascriptInterface
        fun seekBy(offsetMs: Long) {
            runOnUiThread {
                val player = nativePlayer ?: return@runOnUiThread
                if (!player.isCurrentMediaItemSeekable) return@runOnUiThread
                val target = (player.currentPosition + offsetMs).coerceAtLeast(0L)
                val duration = player.duration
                player.seekTo(if (duration > 0L) target.coerceAtMost(duration) else target)
                if (externalAudioActive) {
                    secondaryAudioPlayer?.seekTo(target)
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun seekTo(positionMs: Long) {
            runOnUiThread {
                val player = nativePlayer ?: return@runOnUiThread
                if (!player.isCurrentMediaItemSeekable) return@runOnUiThread
                val target = positionMs.coerceAtLeast(0L).let { requested ->
                    val duration = player.duration
                    if (duration > 0L) requested.coerceAtMost(duration) else requested
                }
                player.seekTo(target)
                if (externalAudioActive) secondaryAudioPlayer?.seekTo(target)
            }
        }

        @android.webkit.JavascriptInterface
        fun setVideoQuality(maxHeight: Int) {
            runOnUiThread {
                val player = nativePlayer ?: return@runOnUiThread
                val height = maxHeight.coerceIn(360, 1080)
                val width = (height * 16f / 9f).roundToInt()
                player.trackSelectionParameters = player.trackSelectionParameters
                    .buildUpon()
                    .setMaxVideoSize(width, height)
                    .build()
            }
        }

        @android.webkit.JavascriptInterface
        fun fetchTextAsync(rawUrl: String, requestId: String) {
            subtitleIoExecutor.execute {
                val payload = try {
                    val uri = Uri.parse(rawUrl.trim())
                    require((uri.scheme == "https" || uri.scheme == "http") && !uri.host.isNullOrBlank()) { "رابط الطلب غير صالح" }
                    val connection = URL(uri.toString()).openConnection() as HttpURLConnection
                    connection.requestMethod = "GET"
                    connection.connectTimeout = 12000
                    connection.readTimeout = 18000
                    connection.instanceFollowRedirects = true
                    connection.setRequestProperty("User-Agent", "SONIX-TV/1.0")
                    connection.setRequestProperty("Accept", "application/json,text/plain,*/*")
                    try {
                        val code = connection.responseCode
                        if (code !in 200..299) throw IllegalStateException("HTTP $code")
                        val bytes = connection.inputStream.use { it.readBytes() }
                        require(bytes.size <= 4 * 1024 * 1024) { "استجابة الإضافة أكبر من الحد المسموح" }
                        JSONObject().put("success", true).put("body", String(bytes, Charsets.UTF_8)).toString()
                    } finally { connection.disconnect() }
                } catch (error: Exception) {
                    JSONObject().put("success", false).put("error", error.message ?: "تعذر الاتصال بمصدر الإضافة").toString()
                }
                runOnUiThread { deliverSubtitleResponse(requestId, payload) }
            }
        }

        @android.webkit.JavascriptInterface
        fun applySubtitleAsync(rawUrl: String, label: String, requestId: String) {
            val requestGeneration = subtitleGeneration.incrementAndGet()
            runOnUiThread {
                if (requestGeneration == subtitleGeneration.get()) {
                    finishSubtitleActivation(false, "تم استبدال طلب الترجمة")
                }
            }
            subtitleIoExecutor.execute {
                var downloaded: File? = null
                val payload = try {
                    val uri = Uri.parse(rawUrl.trim())
                    require((uri.scheme == "https" || uri.scheme == "http") && !uri.host.isNullOrBlank()) { "رابط الترجمة غير صالح" }
                    val connection = URL(uri.toString()).openConnection() as HttpURLConnection
                    connection.connectTimeout = 15000
                    connection.readTimeout = 25000
                    connection.instanceFollowRedirects = true
                    connection.setRequestProperty("User-Agent", "SONIX-TV/1.0")
                    val bytes = try {
                        require(connection.responseCode in 200..299) { "HTTP ${connection.responseCode}" }
                        connection.inputStream.use { it.readBytes() }
                    } finally { connection.disconnect() }
                    require(bytes.isNotEmpty() && bytes.size <= 20 * 1024 * 1024) { "ملف الترجمة فارغ أو أكبر من 20MB" }
                    val ext = (uri.lastPathSegment ?: "").substringAfterLast('.', "srt").lowercase()
                    require(ext in setOf("srt", "vtt", "ssa", "ass", "ttml", "xml")) { "صيغة الترجمة غير مدعومة" }
                    val folder = File(cacheDir, "subtitles").apply { mkdirs() }
                    File(folder, "online_${System.currentTimeMillis()}.$ext").also { file ->
                        FileOutputStream(file).use { it.write(bytes) }
                        downloaded = file
                    }
                    JSONObject().put("success", true).toString()
                } catch (error: Exception) {
                    JSONObject().put("success", false).put("error", error.message ?: "تعذر تنزيل الترجمة").toString()
                }
                runOnUiThread {
                    if (requestGeneration != subtitleGeneration.get()) {
                        deliverSubtitleResponse(requestId, JSONObject().put("success", false)
                            .put("error", "تغير المحتوى قبل اكتمال تحميل الترجمة").toString())
                    } else if (downloaded != null) {
                        attachSubtitleFile(downloaded!!, label.ifBlank { "Online subtitle" }, false, requestId)
                    } else {
                        deliverSubtitleResponse(requestId, payload)
                    }
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun pickSubtitle() {
            runOnUiThread {
                try {
                    subtitlePickerGeneration = subtitleGeneration.incrementAndGet()
                    finishSubtitleActivation(false, "تم اختيار ملف ترجمة جديد")
                    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(
                            "application/x-subrip", "text/vtt", "text/plain",
                            "application/x-ass", "application/ttml+xml", "application/xml"
                        ))
                    }
                    startActivityForResult(intent, subtitlePickerRequestCode)
                } catch (error: Exception) {
                    notifyLocalSubtitleResult(false, "", error.message ?: "تعذر فتح مدير الملفات")
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun hasTextTracks(): Boolean {
            return try {
                nativePlayer?.currentTracks?.groups?.any { it.type == C.TRACK_TYPE_TEXT } == true
            } catch (_: Exception) { false }
        }

        @android.webkit.JavascriptInterface
        fun clearSubtitle() {
            runOnUiThread {
                subtitleGeneration.incrementAndGet()
                finishSubtitleActivation(false, "تم إيقاف الترجمة")
                activeSubtitleFile = null
                nativePlayer?.let { player ->
                    player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
                }
                rebuildCurrentMediaItem(null)
            }
        }

        @android.webkit.JavascriptInterface
        fun setSubtitleStyle(font: String, size: String, color: String, background: String, outline: String, position: String) {
            runOnUiThread {
                val subtitleView = nativePlayerView?.subtitleView ?: return@runOnUiThread
                val foreground = try { android.graphics.Color.parseColor(color) } catch (_: Exception) { android.graphics.Color.WHITE }
                val backgroundColor = when (background) {
                    "translucent" -> android.graphics.Color.argb(150, 0, 0, 0)
                    "solid" -> android.graphics.Color.BLACK
                    else -> android.graphics.Color.TRANSPARENT
                }
                val edgeType = when (outline) {
                    "outline" -> CaptionStyleCompat.EDGE_TYPE_OUTLINE
                    "shadow" -> CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW
                    else -> CaptionStyleCompat.EDGE_TYPE_NONE
                }
                val family = when (font) {
                    "Aref Ruqaa", "Amiri", "Noto Naskh" -> "serif"
                    "Lalezar", "Changa", "Noto Kufi" -> "sans-serif-condensed"
                    "Marhey", "Rakkas", "Lemonada" -> "casual"
                    else -> "sans-serif"
                }
                val typeface = loadSubtitleTypeface(font) ?: Typeface.create(family, Typeface.BOLD)
                subtitleView.setApplyEmbeddedStyles(false)
                subtitleView.setStyle(CaptionStyleCompat(
                    foreground, backgroundColor, android.graphics.Color.TRANSPARENT,
                    edgeType, android.graphics.Color.BLACK, typeface
                ))
                val textSize = size.toFloatOrNull()?.coerceIn(14f, 42f) ?: 24f
                subtitleView.setFixedTextSize(TypedValue.COMPLEX_UNIT_SP, textSize)
                subtitleView.setBottomPaddingFraction(when (position) {
                    "raised" -> 0.18f
                    "middle" -> 0.42f
                    else -> 0.08f
                })
            }
        }

        @android.webkit.JavascriptInterface
        fun setSubtitlesEnabled(enabled: Boolean) {
            runOnUiThread {
                val player = nativePlayer ?: return@runOnUiThread
                player.trackSelectionParameters = player.trackSelectionParameters
                    .buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, !enabled)
                    .build()
            }
        }

        @android.webkit.JavascriptInterface
        fun attachExternalAudioStream(streamId: String, extension: String) {
            runOnUiThread {
                try {
                    val normalizedStreamId = streamId.trim()
                    require(normalizedStreamId.isNotBlank()) { "معرف القناة الصوتية غير صالح" }
                    require(!(nativeVideoStreamType == "live" && nativeVideoStreamId == normalizedStreamId)) {
                        "اختر قناة صوتية مختلفة عن قناة الفيديو"
                    }
                    val mediaUri = xtreamBridge.buildPlaybackUri("live", normalizedStreamId, extension)
                    // The stream IDs have already been compared. Do not compare the
                    // unresolved/rewritten URL strings for native Xtream streams.
                    attachExternalAudioInternal(mediaUri.toString(), compareWithVideo = false)
                } catch (error: Exception) {
                    detachExternalAudioInternal(false)
                    val message = JSONObject.quote(error.message ?: "تعذر استخراج رابط القناة الصوتية من الاشتراك")
                    webView?.evaluateJavascript("window.onExternalAudioError && window.onExternalAudioError($message)", null)
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun attachExternalAudio(url: String) { runOnUiThread { attachExternalAudioInternal(url) } }

        @android.webkit.JavascriptInterface
        fun detachExternalAudio() { runOnUiThread { detachExternalAudioInternal(false) } }

        @android.webkit.JavascriptInterface
        fun setExternalAudioSyncOffset(offsetMs: Int) {
            runOnUiThread { setExternalAudioSyncOffsetInternal(offsetMs.toLong()) }
        }

        @android.webkit.JavascriptInterface
        fun setExternalAudioVolume(volume: Float) {
            runOnUiThread {
                externalAudioVolume = volume.coerceIn(0f, 1f)
                secondaryAudioPlayer?.volume = externalAudioVolume
            }
        }

        @android.webkit.JavascriptInterface
        fun pauseExternalAudio() { runOnUiThread { secondaryAudioPlayer?.pause() } }

        @android.webkit.JavascriptInterface
        fun resumeExternalAudio() {
            runOnUiThread { if (externalAudioActive) secondaryAudioPlayer?.play() }
        }

        @android.webkit.JavascriptInterface
        fun isExternalAudioActive(): Boolean = externalAudioActive

        @android.webkit.JavascriptInterface
        fun resize(left: Float, top: Float, width: Float, height: Float, pixelRatio: Float, cornerRadiusCssPx: Float) {
            runOnUiThread {
                val view = nativePlayerView ?: return@runOnUiThread
                nativePlayerCornerRadiusPx = cssPixelsToAndroidPixels(cornerRadiusCssPx.coerceIn(0f, 32f), pixelRatio).toFloat()
                view.invalidateOutline()
                val container = rootContainer ?: return@runOnUiThread
                val params = calculatePlayerLayoutParams(left, top, width, height, pixelRatio, container, webView)
                if (params == null) {
                    view.visibility = android.view.View.INVISIBLE
                    return@runOnUiThread
                }
                params.gravity = Gravity.TOP or Gravity.LEFT
                view.layoutParams = params
                view.visibility = android.view.View.VISIBLE
            }
        }
    }

    private fun applyVideoFullscreenSystemUi() {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        if (immersiveVideoFullscreen) {
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun attachExternalAudioInternal(rawUrl: String, compareWithVideo: Boolean = true) {
        val url = rawUrl.trim()
        try {
            val uri = Uri.parse(url)
            require((uri.scheme == "http" || uri.scheme == "https") && !uri.host.isNullOrBlank()) {
                "رابط مصدر الصوت الخارجي غير صالح"
            }
            if (compareWithVideo) {
                val currentVideoUrl = nativePlayer?.currentMediaItem?.localConfiguration?.uri?.toString()
                require(currentVideoUrl.isNullOrBlank() || !currentVideoUrl.equals(url, ignoreCase = true)) {
                    "مصدر الصوت يجب أن يكون قناة مستقلة عن مصدر الفيديو"
                }
            }
        } catch (error: Exception) {
            detachExternalAudioInternal(false)
            val message = JSONObject.quote(error.message ?: "رابط الصوت الخارجي غير صالح")
            webView?.evaluateJavascript("window.onExternalAudioError && window.onExternalAudioError($message)", null)
            return
        }
        externalAudioRetryRunnable?.let(externalAudioHandler::removeCallbacks)
        externalAudioRetryRunnable = null
        externalAudioGeneration++
        externalAudioRetryAttempt = 0
        externalAudioSourceUrl = url
        val generation = externalAudioGeneration
        if (!externalAudioActive) {
            nativePlayer?.let { primary ->
                nativeVideoVolumeBeforeExternalAudio = primary.volume
                primary.volume = 0f
            }
        }
        externalAudioActive = true
        webView?.evaluateJavascript("window.onExternalAudioBuffering && window.onExternalAudioBuffering()", null)
        startExternalAudioAttempt(generation)
    }

    private fun startExternalAudioAttempt(generation: Long) {
        if (generation != externalAudioGeneration || !externalAudioActive) return
        releaseSecondaryAudio()
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(5000, 30000, 1500, 5000)
            .build()
        // Use the same IPTV HTTP identity and redirect handling as the primary
        // video player. Some providers reject ExoPlayer's default User-Agent.
        val httpDataSourceFactory = DefaultHttpDataSource.Factory()
            .setUserAgent("SONIX-TV/1.0")
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(30000)
        val mediaSourceFactory = DefaultMediaSourceFactory(httpDataSourceFactory)
        val audioPlayer = ExoPlayer.Builder(this)
            .setLoadControl(loadControl)
            .setMediaSourceFactory(mediaSourceFactory)
            .build().apply {
                trackSelectionParameters = trackSelectionParameters.buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, true).build()
                volume = externalAudioVolume
            }
        secondaryAudioPlayer = audioPlayer
        audioPlayer.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (generation != externalAudioGeneration || secondaryAudioPlayer !== audioPlayer) return
                when (state) {
                    Player.STATE_BUFFERING -> webView?.evaluateJavascript(
                        "window.onExternalAudioBuffering && window.onExternalAudioBuffering()", null)
                    Player.STATE_READY -> {
                        externalAudioRetryRunnable?.let(externalAudioHandler::removeCallbacks)
                        externalAudioRetryRunnable = null
                        externalAudioRetryAttempt = 0
                        applyExternalAudioSyncOffset()
                        webView?.evaluateJavascript(
                            "window.onExternalAudioPlaying && window.onExternalAudioPlaying()", null)
                    }
                    Player.STATE_ENDED -> scheduleExternalAudioRetry(generation)
                    Player.STATE_IDLE -> Unit
                }
            }
            override fun onPlayerError(error: PlaybackException) {
                if (generation != externalAudioGeneration || secondaryAudioPlayer !== audioPlayer) return
                android.util.Log.w("SONIXExternalAudio", "External audio failed: ${error.errorCodeName}")
                scheduleExternalAudioRetry(generation)
            }
        })
        try {
            val audioUri = Uri.parse(externalAudioSourceUrl)
            val extension = audioUri.lastPathSegment
                ?.substringAfterLast('.', "")
                ?.lowercase()
                .orEmpty()
            val mimeType = when (extension) {
                "m3u8" -> MimeTypes.APPLICATION_M3U8
                "mpd" -> MimeTypes.APPLICATION_MPD
                else -> null
            }
            val mediaItem = MediaItem.Builder()
                .setUri(audioUri)
                .apply { if (mimeType != null) setMimeType(mimeType) }
                .build()
            audioPlayer.setMediaItem(mediaItem)
            audioPlayer.prepare()
            audioPlayer.play()
        } catch (error: Exception) {
            android.util.Log.w("SONIXExternalAudio", "Could not start secondary audio player")
            scheduleExternalAudioRetry(generation)
        }
    }

    private fun scheduleExternalAudioRetry(generation: Long) {
        if (generation != externalAudioGeneration || !externalAudioActive) return
        releaseSecondaryAudio()
        externalAudioRetryAttempt = (externalAudioRetryAttempt + 1).coerceAtMost(6)
        val delayMs = externalAudioRetryDelayMs(externalAudioRetryAttempt)
        webView?.evaluateJavascript("window.onExternalAudioBuffering && window.onExternalAudioBuffering()", null)
        val retry = Runnable {
            externalAudioRetryRunnable = null
            if (generation == externalAudioGeneration && externalAudioActive) startExternalAudioAttempt(generation)
        }
        externalAudioRetryRunnable = retry
        externalAudioHandler.postDelayed(retry, delayMs)
    }

    private fun setExternalAudioSyncOffsetInternal(offsetMs: Long) {
        externalAudioSyncOffsetMs = offsetMs.coerceIn(-10000L, 10000L)
        applyExternalAudioSyncOffset()
    }

    private fun applyExternalAudioSyncOffset() {
        val player = secondaryAudioPlayer ?: return
        val offset = externalAudioSyncOffsetMs
        try {
            if (offset > 0L) {
                val position = player.currentPosition
                if (position > offset) player.seekTo(position - offset)
            } else if (offset < 0L) {
                player.seekTo(player.currentPosition + kotlin.math.abs(offset))
            }
        } catch (e: Exception) {
            android.util.Log.w("SONIXExternalAudio", "Offset seek failed", e)
        }
    }

    private fun detachExternalAudioInternal(notifyWeb: Boolean) {
        externalAudioRetryRunnable?.let(externalAudioHandler::removeCallbacks)
        externalAudioRetryRunnable = null
        externalAudioGeneration++
        externalAudioRetryAttempt = 0
        externalAudioSourceUrl = ""
        val wasActive = externalAudioActive
        externalAudioActive = false
        releaseSecondaryAudio()
        if (wasActive && !nativeVideoMuted) {
            nativePlayer?.volume = nativeVideoVolumeBeforeExternalAudio
        }
        if (notifyWeb) {
            webView?.evaluateJavascript(
                "window.onExternalAudioDetached && window.onExternalAudioDetached()", null)
        }
    }

    private fun releaseSecondaryAudio() {
        secondaryAudioPlayer?.let { player ->
            player.stop()
            player.clearMediaItems()
            player.release()
        }
        secondaryAudioPlayer = null
    }

    private fun deliverSubtitleResponse(requestId: String, payload: String) {
        val js = "window.SonixSubtitles && window.SonixSubtitles.onNativeResponse(" +
            JSONObject.quote(requestId) + "," + JSONObject.quote(payload) + ")"
        webView?.evaluateJavascript(js, null)
    }

    private fun loadSubtitleTypeface(font: String): Typeface? {
        subtitleTypefaceCache[font]?.let { return it }
        val source = when (font) {
            "Reem Kufi" -> "arabic-fonts-01.b64" to "reem_kufi"
            "Amiri" -> "arabic-fonts-01.b64" to "amiri"
            "Aref Ruqaa" -> "arabic-fonts-02.b64" to "aref_ruqaa"
            "Lalezar" -> "arabic-fonts-02.b64" to "lalezar"
            "Marhey" -> "arabic-fonts-03.b64" to "marhey"
            "Rakkas" -> "arabic-fonts-03.b64" to "rakkas"
            "Changa" -> "arabic-fonts-04.b64" to "changa"
            "Noto Naskh" -> "arabic-fonts-04.b64" to "noto_naskh_arabic"
            "Lemonada" -> "arabic-fonts-05.b64" to "lemonada"
            "Noto Kufi" -> "arabic-fonts-05.b64" to "noto_kufi_arabic"
            else -> return null
        }
        return try {
            val lines = assets.open("subtitle-fonts/" + source.first).bufferedReader().use { it.readLines() }
            val marker = "@@" + source.second + "@@"
            val index = lines.indexOf(marker)
            if (index < 0 || index + 1 >= lines.size) return null
            val bytes = android.util.Base64.decode(lines[index + 1], android.util.Base64.DEFAULT)
            val directory = File(cacheDir, "subtitle-fonts").apply { mkdirs() }
            val file = File(directory, source.second + ".ttf")
            if (!file.exists() || file.length() != bytes.size.toLong()) {
                FileOutputStream(file).use { it.write(bytes) }
            }
            Typeface.createFromFile(file).also { subtitleTypefaceCache[font] = it }
        } catch (error: Exception) {
            android.util.Log.w("SONIXSubtitle", "Could not load subtitle font $font", error)
            null
        }
    }

    private fun attachSubtitleFile(
        file: File,
        label: String,
        notify: Boolean = true,
        requestId: String? = null
    ) {
        if (nativePlayer == null || activeMediaUri == null) {
            val error = "شغّل الفيديو أولاً قبل إضافة الترجمة"
            if (requestId != null) {
                deliverSubtitleResponse(requestId, JSONObject().put("success", false).put("error", error).toString())
            } else if (notify) notifyLocalSubtitleResult(false, label, error)
            return
        }
        if (!file.exists() || file.length() <= 0L) {
            val error = "ملف الترجمة غير موجود أو فارغ"
            if (requestId != null) {
                deliverSubtitleResponse(requestId, JSONObject().put("success", false).put("error", error).toString())
            } else if (notify) notifyLocalSubtitleResult(false, label, error)
            return
        }

        finishSubtitleActivation(false, "تم استبدال طلب الترجمة")
        activeSubtitleFile = file
        pendingSubtitleRequestId = requestId
        pendingSubtitleLabel = label
        pendingSubtitleNotifyLocal = notify
        nativePlayer?.let { player ->
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .clearOverridesOfType(C.TRACK_TYPE_TEXT)
                .build()
        }
        try {
            rebuildCurrentMediaItem(file)
            val timeout = Runnable {
                finishSubtitleActivation(false, "تعذر على المشغل قراءة مسار الترجمة أو تفعيله")
            }
            subtitleActivationTimeout = timeout
            subtitleActivationHandler.postDelayed(timeout, 15000L)
        } catch (error: Exception) {
            finishSubtitleActivation(false, error.message ?: "تعذر تطبيق الترجمة")
        }
    }

    private fun finishSubtitleActivation(success: Boolean, message: String) {
        subtitleActivationTimeout?.let(subtitleActivationHandler::removeCallbacks)
        subtitleActivationTimeout = null
        val requestId = pendingSubtitleRequestId
        val label = pendingSubtitleLabel
        val notifyLocal = pendingSubtitleNotifyLocal
        pendingSubtitleRequestId = null
        pendingSubtitleLabel = ""
        pendingSubtitleNotifyLocal = false
        if (requestId != null) {
            val response = JSONObject().put("success", success)
            if (!success) response.put("error", message.ifBlank { "تعذر تفعيل الترجمة" })
            deliverSubtitleResponse(requestId, response.toString())
        } else if (notifyLocal && label.isNotBlank()) {
            notifyLocalSubtitleResult(success, label, message)
        }
    }

    private fun rebuildCurrentMediaItem(subtitleFile: File?) {
        val player = nativePlayer ?: return
        val videoUri = activeMediaUri ?: return
        val position = player.currentPosition.coerceAtLeast(0L)
        val wasPlaying = player.playWhenReady
        val builder = MediaItem.Builder().setUri(videoUri)
        if (subtitleFile != null) {
            val ext = subtitleFile.extension.lowercase()
            val mime = when (ext) {
                "vtt" -> "text/vtt"
                "ssa", "ass" -> "text/x-ssa"
                "ttml", "xml" -> "application/ttml+xml"
                else -> "application/x-subrip"
            }
            val config = MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(subtitleFile))
                .setMimeType(mime)
                .setLanguage("und")
                .setLabel(subtitleFile.nameWithoutExtension)
                .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                .build()
            builder.setSubtitleConfigurations(listOf(config))
        }
        player.setMediaItem(builder.build(), position)
        player.prepare()
        player.playWhenReady = wasPlaying
    }

    private fun notifyLocalSubtitleResult(success: Boolean, label: String, message: String) {
        val js = "window.SonixSubtitles && window.SonixSubtitles.onLocalSubtitleResult(" +
            success + "," + JSONObject.quote(label) + "," + JSONObject.quote(message) + ")"
        webView?.evaluateJavascript(js, null)
    }

    @Deprecated("Deprecated in Android")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != subtitlePickerRequestCode || resultCode != RESULT_OK) return
        if (subtitlePickerGeneration != subtitleGeneration.get()) {
            notifyLocalSubtitleResult(false, "", "تغير المحتوى قبل اختيار ملف الترجمة")
            return
        }
        val uri = data?.data ?: return
        try {
            val name = contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
            } ?: "subtitle.srt"
            val ext = name.substringAfterLast('.', "srt").lowercase()
            require(ext in setOf("srt", "vtt", "ssa", "ass", "ttml", "xml")) { "صيغة الملف غير مدعومة" }
            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                ?: throw IllegalStateException("تعذر قراءة الملف")
            require(bytes.isNotEmpty() && bytes.size <= 20 * 1024 * 1024) { "ملف الترجمة فارغ أو أكبر من 20MB" }
            val folder = File(cacheDir, "subtitles").apply { mkdirs() }
            val file = File(folder, "local_${System.currentTimeMillis()}.$ext")
            FileOutputStream(file).use { it.write(bytes) }
            attachSubtitleFile(file, name.substringBeforeLast('.', name))
        } catch (error: Exception) {
            notifyLocalSubtitleResult(false, "", error.message ?: "تعذر قراءة ملف الترجمة")
        }
    }

    private fun inspectUhdCodecCapabilities(format: Format) {
        val mimeType = format.sampleMimeType ?: return
        val width = format.width
        val height = format.height
        if (width <= 0 || height <= 0) return
        val frameRate = format.frameRate.toDouble()
        val results = mutableListOf<String>()
        try {
            val codecInfos = android.media.MediaCodecList(android.media.MediaCodecList.ALL_CODECS).codecInfos
            for (codecInfo in codecInfos) {
                if (codecInfo.isEncoder) continue
                val supportedType = codecInfo.supportedTypes.firstOrNull { it.equals(mimeType, ignoreCase = true) } ?: continue
                try {
                    val videoCapabilities = codecInfo.getCapabilitiesForType(supportedType).videoCapabilities ?: continue
                    val supportsFormat = if (frameRate > 0.0) {
                        videoCapabilities.areSizeAndRateSupported(width, height, frameRate)
                    } else {
                        videoCapabilities.isSizeSupported(width, height)
                    }
                    val acceleration = if (android.os.Build.VERSION.SDK_INT >= 29) {
                        "hardware=" + codecInfo.isHardwareAccelerated
                    } else {
                        "hardware=unknown"
                    }
                    results += codecInfo.name + "(supports=" + supportsFormat + "," + acceleration + ")"
                } catch (error: Exception) {
                    android.util.Log.w("SONIXPlayback", "Could not inspect codec " + codecInfo.name, error)
                }
            }
            val supportedCount = results.count { it.contains("supports=true") }
            android.util.Log.i(
                "SONIXPlayback",
                "UHD_CODEC_SCAN mime=" + mimeType + " size=" + width + "x" + height +
                    " fps=" + frameRate + " supportedDecoders=" + supportedCount +
                    " candidates=" + results.joinToString()
            )
        } catch (error: Exception) {
            android.util.Log.w("SONIXPlayback", "UHD codec capability scan failed", error)
        }
    }

    private fun resetNativePlayerForNextItem() {
        playbackProgressHandler.removeCallbacks(playbackProgressRunnable)
        playbackWatchdogRunnable?.let(playbackRecoveryHandler::removeCallbacks)
        playbackWatchdogRunnable = null
        liveRecoveryRunnable?.let(playbackRecoveryHandler::removeCallbacks)
        liveRecoveryRunnable = null
        bufferingStartedAtMs = 0L
        hasPlaybackReachedReady = false
        liveRecoveryAttempts = 0
        subtitleGeneration.incrementAndGet()
        finishSubtitleActivation(false, "تم تغيير المحتوى قبل تفعيل الترجمة")
        activeMediaUri = null
        activeSubtitleFile = null
        nativePlayerActive = false
        nativePlayerPlaying = false
        nativeVideoStreamType = null
        nativeVideoStreamId = null
        nativePlayer?.let { player ->
            player.stop()
            player.clearMediaItems()
        }
        webView?.evaluateJavascript(
            "window.onNativePlaybackStateChanged && window.onNativePlaybackStateChanged(false)", null)
    }

    private fun startPlaybackWatchdog(player: ExoPlayer) {
        if (nativeVideoStreamType != "live" || player !== nativePlayer) return
        if (bufferingStartedAtMs == 0L) bufferingStartedAtMs = SystemClock.elapsedRealtime()
        playbackWatchdogRunnable?.let(playbackRecoveryHandler::removeCallbacks)
        val timeoutMs = if (hasPlaybackReachedReady) 12_000L else 20_000L
        val watchdog = Runnable {
            if (player !== nativePlayer || !nativePlayerActive || player.playbackState != Player.STATE_BUFFERING) return@Runnable
            val elapsed = SystemClock.elapsedRealtime() - bufferingStartedAtMs
            android.util.Log.w("SONIXPlayback", "Buffering watchdog fired after " + elapsed + "ms; streamId=" + nativeVideoStreamId)
            scheduleLiveRecovery(player, "توقف البث مؤقتاً لأكثر من " + (elapsed / 1000) + " ثانية")
        }
        playbackWatchdogRunnable = watchdog
        playbackRecoveryHandler.postDelayed(watchdog, timeoutMs)
    }

    private fun scheduleLiveRecovery(player: ExoPlayer, reason: String) {
        if (player !== nativePlayer || !nativePlayerActive || nativeVideoStreamType != "live") return
        if (liveRecoveryRunnable != null) return
        webView?.evaluateJavascript(
            "window.onNativePlaybackBuffering && window.onNativePlaybackBuffering('جارٍ إعادة الاتصال بالقناة...')", null)
        if (liveRecoveryAttempts >= 3) {
            val message = "تعذر استعادة القناة بعد 3 محاولات. " + reason
            android.util.Log.e("SONIXPlayback", message)
            stopNativePlayer()
            notifyNativePlaybackError(message)
            return
        }
        liveRecoveryAttempts += 1
        val attempt = liveRecoveryAttempts
        val delayMs = longArrayOf(1_000L, 2_000L, 4_000L)[attempt - 1]
        android.util.Log.w("SONIXPlayback", "Live reconnect attempt " + attempt + "/3 in " + delayMs + "ms: " + reason)
        val retry = Runnable {
            liveRecoveryRunnable = null
            if (player !== nativePlayer || !nativePlayerActive || nativeVideoStreamType != "live") return@Runnable
            val currentItem = player.currentMediaItem
            if (currentItem == null) {
                stopNativePlayer()
                notifyNativePlaybackError("تعذر استعادة القناة: لا يوجد مصدر تشغيل صالح")
                return@Runnable
            }
            try {
                val shouldResume = player.playWhenReady
                bufferingStartedAtMs = SystemClock.elapsedRealtime()
                player.stop()
                player.setMediaItem(currentItem, true)
                player.prepare()
                player.playWhenReady = shouldResume
            } catch (error: Exception) {
                scheduleLiveRecovery(player, error.message ?: "فشلت إعادة الاتصال")
            }
        }
        liveRecoveryRunnable = retry
        playbackRecoveryHandler.postDelayed(retry, delayMs)
    }

    private fun notifyNativePlaybackError(message: String) {
        val quoted = JSONObject.quote(message)
        webView?.evaluateJavascript(
            "window.onNativePlaybackError && window.onNativePlaybackError(" + quoted + ")", null)
    }

    private fun stopNativePlayer() {
        playbackProgressHandler.removeCallbacks(playbackProgressRunnable)
        playbackWatchdogRunnable?.let(playbackRecoveryHandler::removeCallbacks)
        playbackWatchdogRunnable = null
        liveRecoveryRunnable?.let(playbackRecoveryHandler::removeCallbacks)
        liveRecoveryRunnable = null
        bufferingStartedAtMs = 0L
        hasPlaybackReachedReady = false
        liveRecoveryAttempts = 0
        subtitleGeneration.incrementAndGet()
        finishSubtitleActivation(false, "توقف تشغيل المحتوى قبل تفعيل الترجمة")
        activeMediaUri = null
        activeSubtitleFile = null
        nativePlayerActive = false
        nativePlayerPlaying = false
        nativeVideoStreamType = null
        nativeVideoStreamId = null
        nativePlayer?.let { player ->
            player.stop()
            player.clearMediaItems()
            player.release()
        }
        nativePlayer = null

        nativePlayerView?.let { view ->
            view.player = null
            rootContainer?.removeView(view)
        }
        nativePlayerView = null

        webView?.evaluateJavascript(
            "window.onNativePlaybackStateChanged && window.onNativePlaybackStateChanged(false)", null)
    }

    class WebAppInterface(private val activity: MainActivity) {
        @android.webkit.JavascriptInterface
        fun openExternalUrl(rawUrl: String) {
            activity.runOnUiThread {
                try {
                    val uri = Uri.parse(rawUrl.trim())
                    if (uri.scheme == "https" || uri.scheme == "http") {
                        activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
                    }
                } catch (error: Exception) {
                    android.util.Log.w("SONIXAddons", "Unable to open addon configuration URL", error)
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun setTextInputFocused(focused: Boolean) {
            activity.webTextInputFocused = focused
        }

        @android.webkit.JavascriptInterface
        fun closeApp() {
            activity.runOnUiThread {
                activity.finish()
            }
        }
    }

    private fun isSoftwareKeyboardVisible(): Boolean {
        val wv = webView ?: return false
        return ViewCompat.getRootWindowInsets(wv)
            ?.isVisible(WindowInsetsCompat.Type.ime()) == true
    }

    private fun dispatchNativeBack() {
        val wv = webView ?: return
        if (isSoftwareKeyboardVisible()) {
            WindowInsetsControllerCompat(window, wv).hide(WindowInsetsCompat.Type.ime())
            return
        }
        wv.evaluateJavascript(
            "(function() { if (window.handleAndroidBack) { window.handleAndroidBack(); } else if (window.remoteNavigator) { window.remoteNavigator.handleBackAction(); } })()",
            null
        )
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        val wv = webView ?: return super.onKeyDown(keyCode, event)
        if (webTextInputFocused && keyCode in setOf(
                KeyEvent.KEYCODE_DPAD_UP,
                KeyEvent.KEYCODE_DPAD_DOWN,
                KeyEvent.KEYCODE_DPAD_LEFT,
                KeyEvent.KEYCODE_DPAD_RIGHT,
                KeyEvent.KEYCODE_DPAD_CENTER,
                KeyEvent.KEYCODE_ENTER
            )) {
            // Preserve native WebView/IME cursor movement and text-field activation.
            return super.onKeyDown(keyCode, event)
        }
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> {
                dispatchWebKey("ArrowUp")
                return true
            }
            KeyEvent.KEYCODE_DPAD_DOWN -> {
                dispatchWebKey("ArrowDown")
                return true
            }
            KeyEvent.KEYCODE_DPAD_LEFT -> {
                dispatchWebKey("ArrowLeft")
                return true
            }
            KeyEvent.KEYCODE_DPAD_RIGHT -> {
                dispatchWebKey("ArrowRight")
                return true
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                dispatchWebKey("Enter")
                return true
            }
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> {
                dispatchNativeBack()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun dispatchWebKey(keyName: String) {
        val js = """
            (function() {
                var event = new KeyboardEvent('keydown', {
                    key: '$keyName',
                    code: '$keyName',
                    bubbles: true,
                    cancelable: true
                });
                window.dispatchEvent(event);
            })();
        """.trimIndent()
        webView?.evaluateJavascript(js, null)
    }

    override fun onResume() {
        super.onResume()
        if (immersiveVideoFullscreen) window.decorView.post { applyVideoFullscreenSystemUi() }
        webView?.onResume()
        if (resumeNativePlayerAfterPause) nativePlayer?.play()
        if (resumeNativePlayerAfterPause && externalAudioActive) secondaryAudioPlayer?.play()
        resumeNativePlayerAfterPause = false
    }

    override fun onPause() {
        super.onPause()
        webView?.evaluateJavascript(
            "(function() { if (window.videoPlaybackController) { window.videoPlaybackController.pause(); } })()",
            null
        )
        resumeNativePlayerAfterPause = nativePlayer?.isPlaying == true
        nativePlayer?.pause()
        secondaryAudioPlayer?.pause()
        webView?.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && immersiveVideoFullscreen) {
            window.decorView.post { applyVideoFullscreenSystemUi() }
        }
    }

    override fun onDestroy() {
        immersiveVideoFullscreen = false
        applyVideoFullscreenSystemUi()
        detachExternalAudioInternal(false)
        stopNativePlayer()
        subtitleIoExecutor.shutdownNow()
        codecDiagnosticsExecutor.shutdownNow()
        webView?.destroy()
        webView = null
        super.onDestroy()
    }
}


/** Native equivalent of the SONIX screen gradients, visible behind the transparent WebView. */
private class SonixBackgroundDrawable : Drawable() {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun draw(canvas: Canvas) {
        val area = bounds
        val width = area.width().toFloat().coerceAtLeast(1f)
        val height = area.height().toFloat().coerceAtLeast(1f)
        paint.shader = LinearGradient(
            area.left.toFloat(), area.top.toFloat(), area.right.toFloat(), area.bottom.toFloat(),
            Color.rgb(11, 17, 24), Color.rgb(26, 36, 48), Shader.TileMode.CLAMP
        )
        canvas.drawRect(area, paint)
        paint.shader = RadialGradient(
            area.left + width * 0.85f, area.top + height * 0.15f,
            maxOf(width, height) * 0.48f,
            intArrayOf(Color.argb(46, 184, 115, 51), Color.TRANSPARENT),
            floatArrayOf(0f, 1f), Shader.TileMode.CLAMP
        )
        canvas.drawRect(area, paint)
        paint.shader = RadialGradient(
            area.left + width * 0.15f, area.top + height * 0.85f,
            maxOf(width, height) * 0.48f,
            intArrayOf(Color.argb(56, 31, 111, 107), Color.TRANSPARENT),
            floatArrayOf(0f, 1f), Shader.TileMode.CLAMP
        )
        canvas.drawRect(area, paint)
        paint.shader = null
    }

    override fun setAlpha(alpha: Int) {
        paint.alpha = alpha
        invalidateSelf()
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        paint.colorFilter = colorFilter
        invalidateSelf()
    }

    @Deprecated("Deprecated in Android")
    override fun getOpacity(): Int = PixelFormat.OPAQUE
}


internal fun externalAudioRetryDelayMs(attempt: Int): Long {
    val delays = longArrayOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L)
    return delays[(attempt.coerceAtLeast(1) - 1).coerceAtMost(delays.lastIndex)]
}


internal fun cssPixelsToAndroidPixels(value: Float, pixelRatio: Float): Int =
    (value * pixelRatio).roundToInt()

internal fun calculatePlayerLayoutParams(
    left: Float,
    top: Float,
    width: Float,
    height: Float,
    pixelRatio: Float,
    root: FrameLayout?,
    web: WebView?
): FrameLayout.LayoutParams? {
    if (root == null) return null
    val rootWidth = root.width
    val rootHeight = root.height
    if (rootWidth <= 0 || rootHeight <= 0) return null

    var webOffsetX = 0
    var webOffsetY = 0
    if (web != null) {
        val webLocation = IntArray(2)
        val rootLocation = IntArray(2)
        web.getLocationOnScreen(webLocation)
        root.getLocationOnScreen(rootLocation)
        webOffsetX = webLocation[0] - rootLocation[0]
        webOffsetY = webLocation[1] - rootLocation[1]
    }

    val rect = PreviewLayoutCalculator.calculate(
        left, top, width, height, pixelRatio, rootWidth, rootHeight, webOffsetX, webOffsetY
    ) ?: return null

    return FrameLayout.LayoutParams(rect.width, rect.height).apply {
        gravity = Gravity.TOP or Gravity.LEFT
        leftMargin = rect.left
        topMargin = rect.top
    }
}
