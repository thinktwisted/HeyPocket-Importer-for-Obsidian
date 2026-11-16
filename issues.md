# AquariTrack — Release Readiness Issues

Source: full stack + code review of `thinktwisted/AquariTrack` @ branch `cursor/play-release-readiness-71aa` (commit `5b1d104`).
Stack: Kotlin 2.2.21, AGP 8.13.2, Compose BOM 2025.08.01, Room 2.7.2, Hilt 2.58, WorkManager, DataStore, Play Billing 7.1.1, AdMob 24.5.0. minSdk 26 / targetSdk 36.

Severity: **P0** = fix before Play submission · **P1** = high (crash/money/data-loss) · **P2** = medium · **P3** = polish/checklist.

---

## P0 — Release blockers

### P0-1. CAMERA permission requested but never needed; denial permanently kills the Camera button
**Labels:** bug, permissions, play-policy
**Files:** `app/src/main/java/com/aquaritrack/app/ui/photo/PhotoActions.kt:43–61`, `app/src/main/AndroidManifest.xml:10`
`takePicture` grant-checks `CAMERA` before launching `ActivityResultContracts.TakePicture`, but `TakePicture` fires `ACTION_IMAGE_CAPTURE` into the system camera app and requires no permission (no CameraX/camera2 usage anywhere in the codebase). If the user denies the prompt, the callback returns without launching capture (`PhotoActions.kt:44`) — the button is silently dead until permissions are changed in system settings; after permanent denial it does nothing at all. Declaring `CAMERA` without using camera APIs is also a Play permissions-policy exposure.
**Fix:** delete the grant check + `RequestPermission` path and the `<uses-permission android:name="android.permission.CAMERA"/>` declaration; launch capture directly.

### P0-2. False privacy claim shipped to users: "Nothing is uploaded."
**Labels:** security, play-policy, privacy, documentation
**Files:** `app/src/main/java/com/aquaritrack/app/ui/settings/SettingsScreen.kt:219`, `app/src/main/AndroidManifest.xml:19`, `app/src/main/res/xml/backup_rules.xml:4–6`, `app/src/main/res/xml/data_extraction_rules.xml:5–7`, `AquariTrackApplication.kt:30`, `README.md:3`, `aquarium_tracker_app_specification.md:14`
Free users generate live AdMob requests (`MobileAds.initialize`, `BannerAd`), and `allowBackup="true"` pushes the Room DB, DataStore, and all aquarium photos to Google cloud backup. The in-app About text ("stores tanks, photos, and logs on this device. Nothing is uploaded.") and the spec's "100% offline-first, zero cloud dependence" are false. A Data Safety form built on this wording risks rejection or post-launch enforcement.
**Fix:** scope the sentence (e.g. "except ad requests when the free version shows banners; data may be included in your device's Google backup"), and declare Ads SDK data sharing + backup in Play Console.

### P0-3. Setup wizard silently destroys user edits on two reachable interactions
**Labels:** bug, data-loss, onboarding
**Files:** `app/src/main/java/com/aquaritrack/app/ui/tanks/SetupWizardScreen.kt:149–158` (WaterType), `:159–166` (applyDefaults toggle)
Switching WaterType re-overwrites `targets` with defaults and regenerates the task list, discarding all tweaked intervals and enabled/disabled states. Toggling "Apply recommended schedules" off sets `tasks = emptyList()`, permanently deleting custom tasks added via `addCustomTask()`; toggling back restores only stock defaults. Contradicts the on-screen copy "Adjust frequencies before the tank is created" (`:443`). This is the first-run core path.
**Fix:** merge/preserve edited fields on water-type change (or confirm), and keep custom tasks when toggling defaults off; restore stock defaults by id/name rather than replacing the list.

---

## P1 — High priority

### P1-4. Pro entitlement rides Google backup → offline false-Pro on other accounts/devices
**Labels:** bug, billing, security
**Files:** `app/src/main/res/xml/backup_rules.xml:5`, `app/src/main/res/xml/data_extraction_rules.xml:6,11`, `app/src/main/java/com/aquaritrack/app/data/billing/BillingRepositoryImpl.kt:296–304`
`is_pro_user` is cached in DataStore, which is a backed-up domain. Restore onto a different Google account grants ad-free offline; Billing only overwrites the cache when Play is reachable.
**Fix:** exclude the entitlement key from backup, or refuse the cached grant until a fresh `queryPurchasesAsync` on the current account.

### P1-5. Unguarded Room calls in completion flows crash the app on DB errors
**Labels:** bug, crash
**Files:** `app/src/main/java/com/aquaritrack/app/ui/calendar/CalendarScreen.kt:139` (`maintenance.getTask`), `:172` (`recordUsage`); `app/src/main/java/com/aquaritrack/app/ui/calendar/TaskCompleteScreen.kt:101,123`
Same functions wrap `maintenance.complete` in `runCatching` but leave these calls bare; an uncaught SQLite exception (e.g. disk full) propagates to the ViewModelScope handler → process crash, in TaskComplete after the log row is already committed.
**Fix:** wrap in `runCatching` and surface `message` on failure, matching the surrounding pattern.

### P1-6. Linked-supply deduction can silently vanish
**Labels:** bug, inventory, data-integrity
**Files:** `app/src/main/java/com/aquaritrack/app/data/local/entity/Entities.kt:68` (no FK on `linkedConsumableId`), `app/src/main/java/com/aquaritrack/app/ui/calendar/CalendarScreen.kt:146–157,169–181`, `app/src/main/java/com/aquaritrack/app/domain/usecase/InventoryUseCases.kt:20`
Deleting a consumable leaves a dangling `linkedConsumableId` on tasks. Worse: a second completion resolving while a dose dialog is pending overwrites `controls.dose` (last-writer-wins), so the first dose is never deducted; and `confirmDose` shows a "Logged <name>" success when `usage.consumable == null` and nothing was deducted.
**Fix:** queue dose requests (FIFO), add FK with `SET_NULL` (or clear links on consumable delete), and distinguish no-op from logged in the result.

### P1-7. AdView never paused/resumed with lifecycle
**Labels:** bug, ads, play-policy
**Files:** `app/src/main/java/com/aquaritrack/app/ui/components/CommonComponents.kt:44–60`
Only `destroy()` via `AndroidView.onRelease`. Google's required integration calls `AdView.pause()/resume()` on STOP/START; unpaused background banners cause refresh/impression anomalies and are an AdMob policy flag.
**Fix:** add a `LifecycleEventObserver` in `BannerAd`.

### P1-8. "Identify species" ships as a permanently dead button
**Labels:** bug, usability, dead-code
**Files:** `app/src/main/java/com/aquaritrack/app/ui/livestock/LivestockScreens.kt:215–216,291–292`, `app/src/main/java/com/aquaritrack/app/domain/vision/FishVisionClassifier.kt:16–24`, `app/src/main/java/com/aquaritrack/app/di/AppModule.kt:112`
The DI binding is `StubFishVisionClassifier` (always null/0), so the prominent full-width button can only ever print "the vision model is stubbed for a future release" — and each tap overwrites stored AI fields via `saveVisionResult(id, null, 0f, null)`. Guarantees 1-star "broken feature" reviews.
**Fix:** gate the Vision section behind a BuildConfig flag (or hide) until a real model ships; skip `saveVisionResult` when the result is empty.

### P1-9. Affiliate URL injection + arbitrary-scheme intent launches
**Labels:** security
**Files:** `app/src/main/java/com/aquaritrack/app/domain/affiliate/AmazonAffiliateLinkProvider.kt:21–33`, `app/src/main/java/com/aquaritrack/app/ui/shopping/ShoppingScreen.kt:88–92,133–134,291–295`
`buildProductUrl`/`buildMultiItemCartUrl` interpolate ASINs raw into URLs; Shopping manual-add stores `amazonAsin`/`customAffiliateUrl` verbatim while the inventory editor enforces `^[A-Za-z0-9]{10}$` (`InventoryScreens.kt:298`) — inconsistent. An "ASIN" like `B0X&AssociateTag=hijack` rewrites the cart URL's affiliate tag/quantities; `openUrl` fires `ACTION_VIEW` on any scheme (`file:`, `tel:`, `content:`) with no http(s) allow-list.
**Fix:** validate ASIN with the existing regex (or `Uri.encode`), reject non-http(s) custom URLs at store time and launch time.

### P1-10. Tank editor saves inverted parameter ranges; wizard can't
**Labels:** bug, validation, inconsistency
**Files:** `app/src/main/java/com/aquaritrack/app/ui/tanks/TankEditorScreen.kt:155–159` (save validates name/volume only), `app/src/main/java/com/aquaritrack/app/ui/components/ParameterChart.kt:75–84`
A typo'd pH min > max makes every chart point render red and the safe band invisible — false alarm on the app's core value proposition. The wizard runs a min<max `validateTargets` check (`SetupWizardScreen.kt:220`); the editor doesn't.
**Fix:** extract the wizard's `validateTargets` and call it from `TankEditorViewModel.save`.

### P1-11. Bad numeric input silently discarded or mis-saved across forms
**Labels:** bug, validation, data-loss
**Files:** `TankEditorScreen.kt:301–319` (`TargetField`), `SetupWizardScreen.kt:531–545` (`RangeField`), `app/src/main/java/com/aquaritrack/app/ui/parameters/ParameterScreen.kt:110–122`
`TargetField`/`RangeField` only propagate parseable text, and their sync-back `LaunchedEffect` never fires for an unchanged hidden value: a blank/garbage field silently saves the old default with no error. `toOptionalFloat` in ParameterScreen maps typos (`7.2.`) to null so the log saves *without* that reading; if all fields fail to parse, Save does nothing and looks dead.
**Fix:** mark non-blank-but-unparseable fields with inline errors and block save while invalid.

---

## P2 — Medium

### P2-12. Camera button crashes on cameraless devices
**Labels:** bug, crash, compatibility
**Files:** `app/src/main/AndroidManifest.xml:13–15` (`uses-feature required="false"`), `TankEditorScreen.kt:273`, `LivestockEditorScreen.kt:240`, `SetupWizardScreen.kt:353`
`TakePicture.launch` with no registered camera handler throws `ActivityNotFoundException`; not wrapped anywhere. The app still installs on cameraless devices (Chromebooks, tablets).
**Fix:** `runCatching` around launch (or hide the Camera button when `packageManager` can't resolve `IMAGE_CAPTURE` — needs a `<queries>` entry).

### P2-13. Process-death/rotation loses unsaved form state; wizard leaks a staged photo file
**Labels:** bug, state-restoration
**Files:** `SetupWizardScreen.kt:107,116–122`; `ScheduleScreen.kt:106,174–181`; `ShoppingScreen.kt:263–268`; `UsageDialogs.kt:24`
Wizard state is a bare `MutableStateFlow`: a kill mid-wizard restarts at step 0, and since `onCleared` never runs on process death, the staged capture/import file in `filesDir/aquarium_photos/` is orphaned forever (nothing sweeps the dir). Task-edit dialog and shopping/dose dialog fields use non-saveable `remember` and blank out on rotation. `TaskCompleteScreen.kt:150–157` already shows the correct pattern.
**Fix:** hoist to SavedStateHandle/rememberSaveable; add an orphan sweep for `aquarium_photos/` against DB-referenced paths.

### P2-14. One-tap unrecoverable deletes while ConfirmDialog sits unused
**Labels:** usability, data-loss, inconsistency
**Files:** `ScheduleScreen.kt:80–82,279` (Delete adjacent to Cancel in edit dialog), `ShoppingScreen.kt:236`, `ParameterScreen.kt:223`, `LivestockScreens.kt:294–296` (removes the only photo file via `LivestockRepositoryImpl.kt:51–55`), `ShoppingScreen.clearCompleted` loop
`TankEditorScreen.kt:293–300` proves the component exists; these paths skip it.
**Fix:** confirm (or snackbar-undo) for all destructive actions; livestock photo removal is the worst case.

### P2-15. Editors on deleted entities render a permanent blank/loading screen
**Labels:** bug, edge-case
**Files:** `LivestockEditorScreen.kt:104–118`, `InventoryScreens.kt:259–277`, `TankDetailScreen.kt:73` (`filterNotNull`)
`get(id) ?: return@launch` leaves `loaded=false` forever (reachable via stale notification taps or navigating to an id deleted elsewhere).
**Fix:** a `missing` UI state with an explanation + back action.

### P2-16. Dead temperature-unit preference; orphaned Fahrenheit copy
**Labels:** dead-code, settings
**Files:** `SettingsScreen.kt:91–93,157`, `PreferencesRepositoryImpl.kt:30–31,45–47`, `util/Units.kt:7` (`fahrenheitToCelsius` zero callers), `domain/model/Enums.kt:83–90`
No UI ever calls `setTemperature`; °F appears only because the target caption always appends it (`ParameterScreen.kt:294–295`). The "Logs stay in Celsius…" line is the orphaned half of an unshipped toggle.
**Fix:** ship the toggle (input conversion + display) or remove the preference, enum path, and stray copy.

### P2-17. "Add all to Amazon cart" silently adds a subset
**Labels:** bug, shopping
**Files:** `ShoppingScreen.kt:80–86,175–178`
`cartUrl` keeps only ASIN-bearing items; manual items and custom-link-only items are dropped while the button promises "all" and enables if any item qualifies.
**Fix:** show included/total count, or append search URLs for the rest.

### P2-18. Migration 1→2 heuristic silently flips chart semantics; task_logs FK gap
**Labels:** data-integrity, migrations
**Files:** `app/src/main/java/com/aquaritrack/app/data/local/AquariTrackDatabase.kt:49–57`, `Entities.kt:86`
`UPDATE parameter_targets SET nitrateMaxInclusive = 1 WHERE nitrateMinPpm >= 10` changes red-dot semantics for any stored tank with an edited nitrate floor. v1 never shipped, so the migration is dead weight. `task_logs.taskId` has no FK/index, so task deletion leaves dangling references (tolerated but undocumented).
**Fix:** delete the migration (fresh installs start at v2 anyway) or gate it; document/handle `taskId` dangling.

### P2-19. Funky Tropical primary button text fails WCAG AA
**Labels:** accessibility, theme
**Files:** `app/src/main/java/com/aquaritrack/app/ui/theme/Color.kt:19`, `Theme.kt:61–82`
`#FF007F` primary with white `onPrimary` ≈ 3.8:1, below the 4.5:1 required for default button labels — affects every confirm button in that theme.
**Fix:** darken the primary (or set a dark `onPrimary`) and re-check all four schemes.

---

## P3 — Polish & release checklist

### P3-20. i18n half-migrated; ~300 hardcoded English strings in screens
**Files:** all `ui/` screens vs `res/values/strings.xml` (used only for `cd_*`, `billing_*`, `disclaimer_*`, notification strings)
**Fix:** externalize or explicitly document English-only for launch.

### P3-21. Raw SKU shown to users
`SettingsScreen.kt:161–166` prints `aquaritrack_pro_remove_ads` in two sentences. Use product title only.

### P3-22. Cold-start dark flash under light themes
`res/values/themes.xml:6` hardcodes `windowBackground #0B132B` while three of four themes are light. Provide a `-night` qualified (or theme-matched) background.

### P3-23. EXIF transpose cases produce mirrored photos
`PhotoStorage.kt:70–80` maps `TRANSPOSE`/`TRANSVERSE` to rotation-only (no flip) → mirrored output from some front cameras; `writeJpeg` also strips all EXIF (intentional? document it).

### P3-24. Wizard capacity accepts Infinity/NaN
`SetupWizardScreen.kt:249–251`: `toDoubleOrNull` parses `"Infinity"`/`"NaN"` and `NaN <= 0.0` is false → non-finite volume poisons downstream math. Require `isFinite()` (also in `TankEditorScreen.kt:156`).

### P3-25. Minutiae
- Inventory tab resets to "Food" on rotation: `InventoryScreens.kt:137` (`remember` → `rememberSaveable`).
- Stale care hint after renaming a custom task: `SetupWizardScreen.kt:468–472`.
- `tankColor` palette cycles after 12 tanks (ambiguous dot legend): `Color.kt:29–44`.
- Notification ledger grows one key per occurrence forever; prune on task delete/update: `notification/Notifications.kt` (`NotificationLedger`).
- Dead `LaunchedEffect(tankId) { }`: `TankEditorScreen.kt:232`.
- `billing.start()` called twice (init block + `AquariTrackApplication.kt:29`) — guarded, but remove the Application call.
- Time picker forces 24-h: `Pickers.kt:49` — use `DateFormat.is24HourFormat(context)`.
- Verify disclaimer dialog scrolls on small screens / large fonts: `CommonComponents.kt:79–102`.
- Nitrate caption hides the enforced lower bound in exclusive mode: `ParameterScreen.kt:285,293–299`.
- Settings notification/exact-alarm buttons show even when already granted — reflect state.

### P3-26. Play Console / process checklist (not fixable in code)
- Activate one-time product `aquaritrack_pro_remove_ads` before release (else purchase button never loads a price).
- Prepare exact-alarm justification (`SCHEDULE_EXACT_ALARM`, manifest:9); the in-app consent affordance at `SettingsScreen.kt:205–212` is good insurance.
- File Data Safety form honestly: Ads SDK data collection + device backup of DB/photos (see P0-2).
- Permissions declarations must match: drop CAMERA (P0-1), keep POST_NOTIFICATIONS / SCHEDULE_EXACT_ALARM with stated purposes.
- Verify predictive back on Android 16 (targetSdk 36); no `enableOnBackInvokedCallback` needed with Navigation Compose 2.9, but test.
- Add a CI workflow; extend beyond the current logic-only unit tests (`AquariTrackLogicTest`, `BillingEntitlementTest`); no instrumentation tests exist.
- AdMob production IDs are committed publicly (`build.gradle.kts:112–118`) — fine for AdMob, just confirm the units are approved before release.

---

## Verified-good (no action)

- Notification engine: hourly WorkManager backstop + exact alarms + `canScheduleExactAlarms()` fallback + per-`(taskId, dueDate)` notify ledger + receiver-side cancel for deleted/disabled tasks.
- Billing: mutex-guarded entitlement decisions, reconnect backoff, pending-purchase support, ack-failure surfacing, debug-only Pro simulation behind `BuildConfig.DEBUG`.
- Room layer: FK cascades on aquarium deletes, `withTransaction` for create/complete, schema export + explicit migration pipeline.
- Photo staging lifecycle (normal flows): previous staged file deleted, `onCleared` cleanup, capture-target via FileProvider (no storage permissions).
- Date-picker UTC bridging (`Formatters.kt:39–43`) — no off-by-one-day.
- `ScheduleProjector` projection loop guards (`distinctBy`, `guard < 400`, early exits).
- FileProvider/`InitializationProvider` exported=false; WorkManager on-demand init with Hilt factory; ProGuard rules match Room/Hilt/Billing/AdMob needs.
