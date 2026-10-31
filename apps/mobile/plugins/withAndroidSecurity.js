const { withAndroidManifest, withAppBuildGradle } = require("@expo/config-plugins");

module.exports = function withAndroidSecurity(config) {
  config = withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("Android application manifest is missing.");
    }

    application.$["android:usesCleartextTraffic"] = "${usesCleartextTraffic}";
    return config;
  });

  return withAppBuildGradle(config, (config) => {
    const marker = "// Storybook Audio Android release security";
    if (!config.modResults.contents.includes(marker)) {
      config.modResults.contents += `

${marker}
android {
    signingConfigs {
        release {
            def releaseKeystore = System.getenv("ANDROID_KEYSTORE_FILE")
            if (releaseKeystore) {
                storeFile file(releaseKeystore)
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        debug {
            manifestPlaceholders += [usesCleartextTraffic: "true"]
        }
        release {
            signingConfig signingConfigs.release
            manifestPlaceholders += [usesCleartextTraffic: "false"]
        }
    }
}

tasks.configureEach {
    if (name == "validateSigningRelease") {
        doFirst {
            def requiredVariables = [
                "ANDROID_KEYSTORE_FILE",
                "ANDROID_KEYSTORE_PASSWORD",
                "ANDROID_KEY_ALIAS",
                "ANDROID_KEY_PASSWORD"
            ]
            def missingVariables = requiredVariables.findAll { !System.getenv(it) }
            if (missingVariables) {
                throw new GradleException(
                    "Release APK signing requires: \${missingVariables.join(', ')}"
                )
            }
            if (!file(System.getenv("ANDROID_KEYSTORE_FILE")).isFile()) {
                throw new GradleException("ANDROID_KEYSTORE_FILE does not point to a file.")
            }
        }
    }
}
`;
    }
    return config;
  });
};
