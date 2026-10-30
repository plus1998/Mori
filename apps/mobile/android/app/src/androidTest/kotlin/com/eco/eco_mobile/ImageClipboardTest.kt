package com.eco.eco_mobile

import android.content.ComponentName
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ImageClipboardTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val png = Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )

    @Test
    fun publishesOriginalBytesAtReadableImageUri() {
        val uri = ImageClipboard.prepareImage(context, png)

        assertEquals("content", uri.scheme)
        assertEquals("image/png", context.contentResolver.getType(uri))
        val copied = context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
        assertArrayEquals(png, copied)
    }

    @Test
    fun laterCopiesUseDifferentImmutableUris() {
        val first = ImageClipboard.prepareImage(context, png)
        val modified = png + byteArrayOf(0, 1, 2)
        val second = ImageClipboard.prepareImage(context, modified)

        assertNotEquals(first, second)
        assertArrayEquals(png, context.contentResolver.openInputStream(first)!!.use { it.readBytes() })
        assertArrayEquals(modified, context.contentResolver.openInputStream(second)!!.use { it.readBytes() })
    }

    @Test
    fun rejectsNonImagesAndLeavesNoClipboardFiles() {
        val directory = File(context.cacheDir, "clipboard_images")
        val before = directory.list()?.toSet().orEmpty()

        try {
            ImageClipboard.prepareImage(context, byteArrayOf(1, 2, 3, 4))
            throw AssertionError("Expected malformed image data to be rejected")
        } catch (_: IllegalArgumentException) {
            // Invalid data must never be presented to other apps as an image.
        }

        assertEquals(before, directory.list()?.toSet().orEmpty())
    }

    @Test
    fun providerIsPrivateAndAllowsTemporaryUriGrants() {
        val info = context.packageManager.getProviderInfo(
            ComponentName(context, ImageClipboardFileProvider::class.java),
            PackageManager.GET_META_DATA
        )

        assertFalse(info.exported)
        assertTrue(info.grantUriPermissions)
        assertTrue(info.metaData.containsKey("android.support.FILE_PROVIDER_PATHS"))
    }
}
