# Versioning Schema for Kiosk

## Version Format
The versioning format for Kiosk follows the pattern:

`v<major>.<minor>.<patch><platform>`

- `<major>`: Major version number, incremented for significant changes or overhauls.
- `<minor>`: Minor version number, incremented for new features or improvements.
- `<patch>`: Patch version number, incremented for bug fixes or small updates.
- `<platform>`: A single letter representing the platform:
  - `w`: Windows
  - `m`: macOS
  - `a`: Android
  - `e`: Chrome Extension

## Examples
- `v0.1.0w`: Windows version 0.1.0
- `v0.1.0m`: macOS version 0.1.0
- `v0.1.0a`: Android version 0.1.0
- `v1.5e`: Chrome Extension version 1.5

## Guidelines
1. Increment the `<major>` version for breaking changes or significant updates.
2. Increment the `<minor>` version for new features or enhancements.
3. Increment the `<patch>` version for bug fixes or minor updates.
4. Append the platform identifier to distinguish builds for different platforms.

## Notes
- Ensure that each release is tagged appropriately in the repository.
- Maintain consistency in versioning across all platforms.