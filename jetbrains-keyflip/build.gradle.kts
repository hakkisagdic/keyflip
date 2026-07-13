import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.24"
    // IntelliJ Platform Gradle Plugin (1.x line — classic `intellij { }` DSL).
    id("org.jetbrains.intellij") version "1.17.4"
}

group = "dev.keyflip"
version = "0.3.0"

repositories {
    mavenCentral()
}

// Target IntelliJ IDEA Community 2023.2.x (build 232). The Terminal plugin is bundled and is
// depended upon for the "Open Dashboard" action.
intellij {
    version.set("2023.2")
    type.set("IC")
    plugins.set(listOf("org.jetbrains.plugins.terminal"))
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks {
    withType<KotlinCompile> {
        kotlinOptions {
            jvmTarget = "17"
        }
    }

    patchPluginXml {
        sinceBuild.set("232")
        untilBuild.set("242.*")
    }

    // The plugin has no persisted searchable options to index; skip the slow headless run.
    buildSearchableOptions {
        enabled = false
    }

    test {
        useJUnit()
    }
}
