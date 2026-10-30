package com.eco.eco_mobile

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    private var imageClipboard: ImageClipboard? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        imageClipboard = ImageClipboard(applicationContext, flutterEngine.dartExecutor.binaryMessenger)
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        imageClipboard?.dispose()
        imageClipboard = null
        super.cleanUpFlutterEngine(flutterEngine)
    }
}
