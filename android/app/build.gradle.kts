// SPDX-License-Identifier: AGPL-3.0-only
plugins {
    id("com.android.application")
}

val releaseStore = providers.environmentVariable("KLEBB_SIGNING_STORE")
val releasePassword = providers.environmentVariable("KLEBB_SIGNING_STORE_PASSWORD")
val releaseAlias = providers.environmentVariable("KLEBB_SIGNING_ALIAS")
val releaseKeyPassword = providers.environmentVariable("KLEBB_SIGNING_KEY_PASSWORD")
val healthContractRoot = providers.gradleProperty("healthContractRoot").orNull?.let { file(it) }
    ?: rootProject.projectDir.parentFile

android {
    namespace = "app.klebb.companion"
    compileSdk = 37
    compileSdkMinor = 0
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = "app.klebb.companion"
        minSdk = 28
        targetSdk = 37
        versionCode = providers.gradleProperty("proofVersionCode").orElse("1").get().toInt()
        versionName = providers.gradleProperty("proofVersionName").orElse("0.1.0-proof").get()
        buildConfigField("String", "HEALTH_CONNECT_SDK", "\"1.2.0-alpha06\"")
    }
    signingConfigs {
        create("release") {
            storeFile = file(releaseStore.orElse("missing-release-key.jks").get())
            storePassword = releasePassword.orNull
            keyAlias = releaseAlias.orNull
            keyPassword = releaseKeyPassword.orNull
        }
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
        }
    }
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets.getByName("test").resources.srcDir(
        healthContractRoot.resolve("tests/fixtures/health-connect")
    )
    sourceSets.getByName("test").resources.srcDir(
        healthContractRoot.resolve("schemas/health-connect")
    )
    sourceSets.getByName("main").assets.srcDir(
        healthContractRoot.resolve("schemas/health-connect")
    )
}

dependencyLocking {
    lockAllConfigurations()
}

tasks.configureEach {
    if (name == "validateSigningRelease") {
        doFirst {
            check(listOf(releaseStore, releasePassword, releaseAlias, releaseKeyPassword)
                .all { it.isPresent && it.get().isNotBlank() }) {
                "Release signing requires all four KLEBB_SIGNING_* variables; see README.md."
            }
        }
    }
}

dependencies {
    // The alpha exposes activity intensity and newer exercise fields omitted by 1.1.0.
    implementation("androidx.health.connect:connect-client:1.2.0-alpha06")
    implementation("androidx.activity:activity:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
}
