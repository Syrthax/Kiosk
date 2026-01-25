#!/bin/bash
# Gradle wrapper bootstrap script

GRADLE_VERSION="8.2"

# Download gradle wrapper if not exists
if [ ! -f "gradle/wrapper/gradle-wrapper.jar" ]; then
    echo "Downloading Gradle wrapper..."
    mkdir -p gradle/wrapper
    
    # Use system gradle if available, otherwise download
    if command -v gradle &> /dev/null; then
        gradle wrapper --gradle-version $GRADLE_VERSION
    else
        # Download wrapper jar directly
        curl -L -o gradle/wrapper/gradle-wrapper.jar \
            "https://github.com/gradle/gradle/raw/v${GRADLE_VERSION}/gradle/wrapper/gradle-wrapper.jar"
    fi
fi

# Run gradle
./gradlew "$@"
