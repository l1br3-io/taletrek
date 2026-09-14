package dev.l1br3.taletrek.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import dev.l1br3.taletrek.MainActivity
import dev.l1br3.taletrek.ffi.PipelineHandle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The convert host: a foreground `dataSync` [Service] owning one
 * [SynthController] job at a time. The kernel decides everything; this
 * class is the Android shell — foreground promotion + progress
 * notification + cancel action + a partial wake lock so synthesis survives
 * screen-off (the FGS keeps the process alive; the lock keeps the CPU
 * fed).
 *
 * GOTCHA (hit in the task-005 smoke): a fresh controller + engine is built
 * **per job**, not per service instance — Android routinely reuses a live
 * service instance across start intents (a just-`stopSelf`ed service may
 * not be destroyed before the next `startForegroundService`), and a
 * per-instance engine would wedge the second job onto the first's runner.
 * While a job runs, further submits are rejected (one at a time).
 *
 * FGS type decision (task 005, spec open question): `dataSync`. Jobs are
 * minutes (the T2 datapoint: ~0.6 s/paragraph on an emulator), far under
 * Android 15's 6 h dataSync cap — and `mediaProcessing` (API 35+) would
 * strand API 26–34 devices. Escalation if real jobs ever approach the cap:
 * chunk-stamp-resume (the worker stamps incrementally). The 2-arg
 * [startForeground] inherits the manifest's `foregroundServiceType`.
 *
 * The UI (import flow, task 006) collects [active] — a process-wide
 * single-job slot — so progress survives navigation and the activity never
 * owns the job.
 */
class SynthService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var notifications: NotificationManager
    private var wakeLock: PowerManager.WakeLock? = null

    private var controller: SynthController? = null
    private var collectJob: Job? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        notifications = getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Converting",
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
    }

    /** The seam — instrumented smokes inject a fake engine before start. */
    private fun engineFactory(): SynthEngine =
        seamOverride
            ?: HandleSynthEngine { config -> PipelineHandle(config) }

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        // GOTCHA: promote FIRST, synchronously, with a generic notification —
        // the FGS contract gives startForegroundService() a 5 s window and
        // waiting on the state-flow collector to notice Preparing lost that
        // race under scheduling jitter (ForegroundServiceDidNotStartInTime
        // killed the process). Later states just re-notify the same id.
        startForeground(NOTIFICATION_ID, buildNotification(SynthUiState.Preparing(null, null)))
        when (intent?.action) {
            ACTION_CANCEL -> controller?.cancel()
            else ->
                intent?.let { SynthJobRequest.fromIntent(it) }?.let { request ->
                    controllerForJob().submit(request)
                }
        }
        return START_NOT_STICKY
    }

    /**
     * The live controller, or a fresh one when idle/terminal — each job
     * gets a fresh engine + a fresh main-dispatched collector (kernel
     * events land on worker threads; StateFlow serializes them; every
     * notification side effect below runs on main — the 004 observer
     * contract applied at the service boundary).
     */
    private fun controllerForJob(): SynthController {
        controller?.let { current ->
            if (current.isRunning()) return current
        }
        collectJob?.cancel()
        _active.value = null
        val fresh = SynthController(engineFactory())
        controller = fresh
        collectJob =
            serviceScope.launch {
                fresh.state.collect { onState(it) }
            }
        return fresh
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(pendingStop)
        runCatching { controller?.cancel() }
        serviceScope.cancel()
        releaseWake()
        _active.value = null
        super.onDestroy()
    }

    /** Reduce controller state → notification + wake lock + lifetime. */
    private fun onState(state: SynthUiState) {
        _active.value = state
        when (state) {
            SynthUiState.Idle -> Unit
            is SynthUiState.Preparing,
            is SynthUiState.DownloadingVoice,
            is SynthUiState.Synthesizing,
            SynthUiState.Writing,
            -> {
                acquireWake()
                startForeground(NOTIFICATION_ID, buildNotification(state))
                notifications.notify(NOTIFICATION_ID, buildNotification(state))
            }
            is SynthUiState.Done,
            is SynthUiState.Failed,
            SynthUiState.Cancelled,
            -> {
                releaseWake()
                // GOTCHA: stopForeground(REMOVE) would also kill the
                // terminal notification we WANT the user to see — detach
                // (the ongoing flag drops with the service), then
                // re-notify the same id with an autoCancel summary.
                stopForeground(STOP_FOREGROUND_DETACH)
                notifications.notify(NOTIFICATION_ID, buildNotification(state))
                // GOTCHA: stopSelf() right at the terminal races the next
                // startForegroundService — the system can be mid-teardown
                // of the ServiceRecord and unsatisfiable ("Bringing down
                // service while still waiting for start foreground" →
                // ForegroundServiceDidNotStartInTime kills the process; hit
                // in the task-005 smoke). Linger briefly so back-to-back
                // jobs reuse the live record; the check keeps a genuinely
                // new job alive.
                mainHandler.removeCallbacks(pendingStop)
                mainHandler.postDelayed(pendingStop, STOP_DELAY_MS)
            }
        }
    }

    private val pendingStop: () -> Unit = {
        if (controller?.isRunning() != true) {
            stopSelf()
        }
    }

    private fun acquireWake() {
        if (wakeLock == null) {
            wakeLock =
                getSystemService(PowerManager::class.java)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "taletrek:synth")
                    .apply {
                        setReferenceCounted(false)
                        acquire(WAKE_TIMEOUT_MS)
                    }
        }
    }

    private fun releaseWake() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    private fun buildNotification(state: SynthUiState): android.app.Notification {
        val (title, text, progress) = state.notificationCopy()
        val ongoing = state.isOngoing()
        val content =
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val cancel =
            PendingIntent.getService(
                this,
                1,
                Intent(this, SynthService::class.java).setAction(ACTION_CANCEL),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val builder =
            NotificationCompat
                .Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(title)
                .setContentText(text)
                .setOnlyAlertOnce(true)
                .setOngoing(ongoing)
                .setAutoCancel(!ongoing)
                .setContentIntent(content)
        if (ongoing) {
            builder.addAction(0, "Cancel", cancel)
        }
        when (progress) {
            is Progress.Determinate -> builder.setProgress(100, progress.percent, false)
            is Progress.Indeterminate -> builder.setProgress(0, 0, true)
            null -> builder.setProgress(0, 0, false)
        }
        return builder.build()
    }

    private fun SynthUiState.isOngoing(): Boolean =
        this is SynthUiState.Preparing ||
            this is SynthUiState.DownloadingVoice ||
            this is SynthUiState.Synthesizing ||
            this is SynthUiState.Writing

    private fun SynthUiState.notificationCopy(): Triple<String, String, Progress?> =
        when (this) {
            SynthUiState.Idle -> Triple("TaleTrek", "", null)
            is SynthUiState.Preparing ->
                Triple(
                    "Converting document",
                    if (paragraphs != null && paragraphs > 0) {
                        "$chapters chapters · $paragraphs paragraphs"
                    } else {
                        "Reading…"
                    },
                    Progress.Indeterminate,
                )
            is SynthUiState.DownloadingVoice ->
                Triple(
                    "Downloading",
                    if (total > 0) {
                        "${done / (1024 * 1024)} of ${total / (1024 * 1024)} MB"
                    } else {
                        "Downloading…"
                    },
                    if (total > 0) {
                        Progress.Determinate(((done * 100) / total).toInt())
                    } else {
                        Progress.Indeterminate
                    },
                )
            is SynthUiState.Synthesizing ->
                Triple(
                    "Synthesizing",
                    if (total > 0) "$done of $total paragraphs" else "Starting…",
                    if (total > 0) {
                        Progress.Determinate(((done * 100) / total).toInt())
                    } else {
                        Progress.Indeterminate
                    },
                )
            SynthUiState.Writing -> Triple("Finishing", "Writing bundle…", Progress.Indeterminate)
            is SynthUiState.Done -> Triple("Book ready", "Audio book ready", null)
            is SynthUiState.Failed -> Triple("Conversion failed", message, null)
            SynthUiState.Cancelled -> Triple("Conversion cancelled", "", null)
        }

    private sealed interface Progress {
        data class Determinate(
            val percent: Int,
        ) : Progress

        data object Indeterminate : Progress
    }

    companion object {
        const val ACTION_START = "dev.l1br3.taletrek.synth.START"
        const val ACTION_CANCEL = "dev.l1br3.taletrek.synth.CANCEL"
        private const val CHANNEL_ID = "synth"
        private const val NOTIFICATION_ID = 41

        private val _active = MutableStateFlow<SynthUiState?>(null)

        /** Process-wide single-job progress — the UI's (and tests') window. */
        val active: kotlinx.coroutines.flow.StateFlow<SynthUiState?> = _active.asStateFlow()

        /** Instrumented smokes swap in a fake engine before starting. */
        @Volatile
        var seamOverride: SynthEngine? = null

        private const val WAKE_TIMEOUT_MS = 2 * 60 * 60 * 1000L
        private const val STOP_DELAY_MS = 1500L
    }
}
