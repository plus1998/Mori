package com.eco.eco_mobile

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors

// Only this private cache subdirectory is shared by the provider. Clipboard
// readers receive a temporary read grant from Android, never broad file access.
class ImageClipboardFileProvider : FileProvider()

internal class ImageClipboard(context: Context, messenger: BinaryMessenger) {
    private val app = context.applicationContext
    private val channel = MethodChannel(messenger, "eco_mobile/image_clipboard")
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    init {
        channel.setMethodCallHandler { call, result ->
            if (call.method != "copyImage") {
                result.notImplemented()
                return@setMethodCallHandler
            }
            val bytes = call.argument<ByteArray>("bytes")
            if (bytes == null || bytes.isEmpty()) {
                result.error("invalid_image", "Original image bytes are required.", null)
                return@setMethodCallHandler
            }
            worker.execute {
                try {
                    val uri = prepareImage(app, bytes)
                    main.post {
                        try {
                            val clipboard = app.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                            if (clipboard == null) {
                                result.error("clipboard_unavailable", "Clipboard service is unavailable.", null)
                            } else {
                                clipboard.setPrimaryClip(ClipData.newUri(app.contentResolver, "Mori image", uri))
                                if (clipboard.primaryClip?.getItemAt(0)?.uri != uri) {
                                    result.error("copy_failed", "Clipboard did not accept the image.", null)
                                } else {
                                    result.success(true)
                                }
                            }
                        } catch (error: Exception) {
                            result.error("copy_failed", error.message, null)
                        }
                    }
                } catch (error: IllegalArgumentException) {
                    main.post { result.error("invalid_image", error.message, null) }
                } catch (error: Exception) {
                    main.post { result.error("copy_failed", error.message, null) }
                }
            }
        }
    }

    fun dispose() {
        channel.setMethodCallHandler(null)
        worker.shutdown()
    }

    companion object {
        internal fun prepareImage(context: Context, bytes: ByteArray): Uri {
            require(bytes.isNotEmpty()) { "Original image bytes are required." }
            // Read headers for the MIME type only. Never decode/re-encode pixels.
            val header = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, header)
            val mime = header.outMimeType
            require(header.outWidth > 0 && header.outHeight > 0 && mime?.startsWith("image/") == true) {
                "Unsupported image data."
            }
            val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
            require(extension != null && extension.matches(Regex("[a-zA-Z0-9]+"))) {
                "Unsupported image MIME type."
            }
            val directory = File(context.cacheDir, "clipboard_images")
            if (!directory.isDirectory && !directory.mkdirs()) {
                throw IOException("Cannot create clipboard image cache.")
            }
            // Unique, immutable files keep older clipboard URIs valid when a
            // later image is copied. Do not delete on preview/activity disposal.
            val file = File(directory, "${UUID.randomUUID()}.$extension")
            file.writeBytes(bytes)
            return FileProvider.getUriForFile(context, "${context.packageName}.image_clipboard", file)
        }
    }
}
