plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ktlint)
}

android {
    namespace = "dev.l1br3.taletrek"
    // compileSdk 37: Compose BOM 2026.08 (animation-core 1.12) requires it.
    // targetSdk stays the current stable OS (36) per the spec.
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.l1br3.taletrek"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // The kernel ships as prebuilt jniLibs from `just android-kernel`
        // (cargo-ndk); Gradle never invokes Cargo. The filter also keeps
        // dependency-bundled .so (JNA ships four ABIs) to the two we run.
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    // The committed kernel fixtures ride in as androidTest assets —
    // single source of truth with the Rust suites, no copied files.
    sourceSets {
        getByName("androidTest") {
            assets.directories += "../crates/synth/tests/fixtures"
        }
    }
}

// AGP 9 built-in Kotlin — compiler options live in the top-level kotlin {}
// DSL (the android.kotlinOptions form is gone).
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

ktlint {
    // Generated UniFFI Kotlin is regenerated, never hand-edited.
    filter {
        exclude("**/ffi/**")
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    // Media3 pre-added for the playback service (task 003).
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.session)
    // UniFFI's generated Kotlin is JNA-based.
    implementation(libs.jna) {
        artifact {
            type = "aar"
        }
    }
    debugImplementation(libs.androidx.compose.ui.tooling)

    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.core)
}
