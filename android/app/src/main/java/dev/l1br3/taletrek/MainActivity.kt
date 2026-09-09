package dev.l1br3.taletrek

import android.Manifest
import android.content.ComponentName
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import dev.l1br3.taletrek.playback.PlaybackService
import dev.l1br3.taletrek.playback.SessionCommands
import dev.l1br3.taletrek.ui.theme.TaletrekTheme
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import java.io.File

class MainActivity : ComponentActivity() {
    private var controllerFuture: java.util.concurrent.Future<MediaController>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        controllerFuture = mediaControllerFuture()
        setContent {
            TaletrekTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    DebugTransportScreen(controller = controllerFuture!!.get())
                }
            }
        }
    }

    override fun onDestroy() {
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.onDestroy()
    }

    private fun mediaControllerFuture() =
        MediaController
            .Builder(
                this,
                SessionToken(this, ComponentName(this, PlaybackService::class.java)),
            ).buildAsync()
}

// DEBUG: replaced in 005/007 — a temporary transport driver over the
// MediaController so the Jog core is drivable before any real UI exists.
@Suppress("FunctionName") // Compose factory convention — PascalCase composables
@Composable
fun DebugTransportScreen(controller: MediaController) {
    val context = LocalContext.current
    var status by remember { mutableStateOf("no book") }

    val notifPermission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 && notifPermissionShouldRequest()) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    val pickBook =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) {
                val dest = File(File(context.filesDir, "books"), "debug.taletrek")
                dest.parentFile?.mkdirs()
                context.contentResolver.openInputStream(uri)?.use { input ->
                    dest.outputStream().use { output -> input.copyTo(output) }
                }
                controller.sendCustomCommand(
                    SessionCommands.OPEN_BOOK,
                    Bundle().apply { putString(SessionCommands.EXTRA_PATH, dest.absolutePath) },
                )
            }
        }

    // Poll the kernel's state (007 replaces polling with real observation).
    val mainExecutor = remember { java.util.concurrent.Executor(Handler(Looper.getMainLooper())::post) }
    LaunchedEffect(Unit) {
        while (currentCoroutineContext().isActive) {
            val future = controller.sendCustomCommand(SessionCommands.GET_STATE, Bundle.EMPTY)
            future.addListener(
                {
                    val extras = future.get().extras
                    val ch = extras.getLong(SessionCommands.STATE_CHAPTER)
                    val para =
                        if (ch < 0) {
                            ""
                        } else {
                            " ¶$ch:${extras.getLong(SessionCommands.STATE_INDEX)} @${extras.getDouble(SessionCommands.STATE_OFFSET)}s"
                        }
                    status =
                        "${extras.getString(SessionCommands.STATE_STATUS) ?: "?"}$para " +
                        "skipped=${extras.getLong(SessionCommands.STATE_SKIPPED)}"
                },
                mainExecutor,
            )
            delay(500)
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = status, style = MaterialTheme.typography.titleMedium)
        Button(onClick = { pickBook.launch(arrayOf("*/*")) }) { Text("Import bundle…") }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { controller.seekToPrevious() }) { Text("ch−") }
            OutlinedButton(onClick = { controller.seekToNext() }) { Text("ch+") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = { controller.sendCustomCommand(SessionCommands.PREV_PARAGRAPH, Bundle.EMPTY) },
            ) { Text("¶−") }
            OutlinedButton(
                onClick = { controller.sendCustomCommand(SessionCommands.NEXT_PARAGRAPH, Bundle.EMPTY) },
            ) { Text("¶+") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { controller.play() }) { Text("▶") }
            OutlinedButton(onClick = { controller.pause() }) { Text("⏸") }
        }
    }
}

private fun notifPermissionShouldRequest() = true
