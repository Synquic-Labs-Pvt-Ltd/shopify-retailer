# @rs/mobile

The Retailer Studio app: Expo SDK 57, run as a dev build (not Expo Go). Spec: [docs/SPEC.md](../../docs/SPEC.md), sections 16 and 17.

```sh
cp .env.example .env
pnpm -F @rs/mobile typecheck
pnpm -F @rs/mobile lint
pnpm -F @rs/mobile start          # expo start --dev-client
```

## Environment

| Variable | Meaning |
|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | Backend base URL without a trailing slash. Android emulator: `http://10.0.2.2:3000`. |
| `EXPO_PUBLIC_API_MOCK` | `true` serves in-memory fixtures and needs no backend. |
| `EXPO_PUBLIC_PRIVACY_URL`, `EXPO_PUBLIC_TERMS_URL`, `EXPO_PUBLIC_SUPPORT_URL` | Optional targets of the Login footer links. |

Only `EXPO_PUBLIC_*` values reach the app. Never put secrets here.

## Mock mode

With `EXPO_PUBLIC_API_MOCK=true` the API client is replaced by the in-memory fixtures of the `@rs/mock-api` workspace package (`packages/mock-api`, re-exported by `src/api/mock/`; see [Feature screens](#feature-screens) for the whole create-batch flow).

- Login keeps its normal validation but skips the browser: the domain field starts as `mock-store`, a login code is fabricated, and the mock `POST /auth/exchange` returns a session for "Mock Store". Login, tabs, Account and Log out all work without a backend.
- The mock `refresh`, `logout` and `me` are served too, so the refresh token kept in secure storage restores the session on the next app start.
- Staged upload targets are `mock://staged-upload`: the upload feature skips the multipart POST and simulates it with timed fake progress.
- Restart Metro after changing `.env`; Expo inlines `EXPO_PUBLIC_*` values at bundle time.

## Feature screens

Code lives in `src/features/{products,references,queue,results}`, the typed hooks in `src/api` (`products.ts`, `media.ts`, `batches.ts`, query keys in `keys.ts`, error mapping in `errors.ts`) and the persisted draft in `src/state/draft.ts`.

- **Products**: infinite scroll (20 per page), debounced search, pull to refresh, single and bulk selection (`Select all` / `Clear`). The selection lives in the draft; the sticky footer shows `{n} selected` and `Continue`. Selecting beyond `maxProductsPerBatch` from `GET /me` is refused with a toast.
- **References**: common references and one card per product, live resolution through `resolveReferences` from `@rs/shared`, the warning banner, and `Generate {n} products` (disabled until every product resolves and every slot is ready). A 422 `references_required` from the server maps to the same banner.
- **Queue / BatchDetail**: batch cards poll every 8 s and the detail every 4 s while the batch is not terminal (polling pauses when the screen is not focused). Cancel asks with a native Alert; Retry failed shows on a terminal batch with failed jobs.
- **ItemResults / MediaViewer**: 3:4 grid, full-screen pager, download, share and `Download all` (`Saving 2 of 3`, continues after a failure).
- A 409 `shop_reauth_required` is handled once, in the API client: it clears the session, and the auth gate shows Login.

### Reference upload (SPEC 8.6)

1. Pick (camera, video or library) and validate against `GET /me` (`references.*`: counts, mime types, image and video size, video length). Rejections are summarized in one toast.
2. Images: HEIC and HEIF become JPEG, and every image is downscaled to a 2048 px long edge at quality 0.9 (`expo-image-manipulator`). Videos are uploaded as they are.
3. `POST /media/uploads` (one call per pick) -> one multipart `POST` per file straight to the returned target (parameters first, the file last, with upload progress from `xhr.upload`, two uploads at a time) -> `POST /media/:id/complete`.
4. `GET /media?ids=` is polled with a back-off from 1.5 s to 3 s until the reference is `ready` or `failed` (a reference stuck for 5 minutes fails). The poll resumes on its own after an app restart, because the draft keeps the media ids.
5. A failed slot (red ring) retries from its local file on tap. Removing a slot aborts its upload and calls `DELETE /media/:id`.

An upload that was running when the app was killed comes back as failed ("The upload was interrupted") and is retried with a tap. The draft is bound to the shop id; logging in to another shop starts a fresh draft.

### Running the whole flow in mock mode

Set `EXPO_PUBLIC_API_MOCK=true` in `.env`, restart Metro, log in with the default `mock-store`, then:

1. **Products** (45 fixtures, 3 pages): scroll for infinite loading, pull to refresh, search `lamp`. Search `zzz` shows the empty state and `error` shows the error banner (with Retry). The 13th product has no image. Select a few products.
2. **Continue -> References**: the banner says the products need a reference. Add references with `+` (the bottom sheet offers camera, video and library; pick real files on a device or emulator). Slots go uploading (fake progress) -> processing (spinner, about 2 s for an image and 5 s for a video) -> ready. To see the failure paths: every 4th new file stops partway through the upload and every 7th ends in a failed processing step; tap the red slot to retry (a retry always succeeds). Per-product references switch that card to `{k} references + common` or `{k} references`; a common reference makes the others `Uses common references`; removing the last reference brings the warning back.
3. **Generate**: the toast `Generation queued` plus a success haptic, the draft is cleared, and BatchDetail opens on top of the Queue tab. The mock batch is a function of the clock: queued -> running (plans, then outputs appear one by one in the strips) -> a delay banner between 3.5 s and 9 s -> `With errors` at about 12 s, because the video of the second product fails.
4. **Retry failed** (BatchDetail footer): the failed video runs again and succeeds after about 6 s; the batch ends `Completed`. **Cancel** (shown while running) confirms with an Alert and freezes the batch as `Cancelled`.
5. **Queue**: three older batches are seeded (completed, with errors, cancelled; the one with errors can be retried), and new ones appear at the top. Starting a fourth batch while three are running returns 429 `shop_limit` and shows its message as a toast.
6. **ItemResults**: tap an item. Images and the video poster (play glyph, duration pill) open the **MediaViewer**: swipe between outputs, double-tap or pinch an image, tap the video to pause, the speaker button un-mutes. Download, share and `Download all` use the real file system, media library and share sheet, so they need a device or emulator; the mock outputs are public picsum images and a sample mp4. The failed video shows as a red tile with its error code.

### Not verified here (device only)

Nothing below ran: this track had no emulator, device, prebuild or Gradle. The code type-checks, lints and bundles (`expo export --platform android`), and the library calls were checked against the installed type declarations and, for the upload progress, the React Native 0.86 source.

- The real multipart upload to Shopify's staged targets and the upload progress events (`xhr.upload.onprogress` is emitted by React Native's Android network module; not exercised against a live target).
- Camera and video capture, the Android photo picker, HEIC conversion, and the 2048 px downscale (including EXIF rotation).
- `expo-media-library` write-only permission prompt and `Asset.create` (on Android 10 and newer a "not granted" answer is not treated as final, because adding a file needs no permission there), `expo-file-system` downloads, and the share sheet.
- Pinch, drag and double-tap zoom inside the paging list (the pan only claims the touch while zoomed, so the pager keeps swiping at 1x), looping muted video playback, and the viewer status bar.
- iOS: the picker is opened 400 ms after the sheet closes to avoid presenting while the modal is dismissing; iOS is not verified.
- If Android destroys the activity while the camera is open, the picked file is lost (`getPendingResultAsync` is not wired).

## Design gallery (development only)

`src/design/gallery/DesignGalleryScreen.tsx` renders every design system component in all of its states: color and type tokens, buttons in every tone and state, fields, chips, filter chips, segmented control, status chips, banners, toasts, the bottom sheet, empty state, skeleton, progress, status ticker, media slots (empty, uploading, processing, ready image, ready video, failed), images, list rows, panel, the sticky footer and the floating tab bar.

Open it by long-pressing the **Account** screen title. The route is registered, and the module is required, only when `__DEV__` is true, so release bundles contain neither.

## Design system

Everything is exported from `src/design` (`import { PrimaryButton, useToast, colors } from '../../design'`).

- Tokens: `colors`, `typography`, `spacing`, `radii`, `borders`, `shadows`, `motion`, `components`, `layout` in `theme.ts`.
- Components: `AppText`, `PressableScale`, `Screen`, `Icon`, `Image`, `PrimaryButton`, `Field`, `Chip`, `FilterChips`, `SegmentedControl`, `StatusChip`, `Banner`, `ScreenHeader`, `IconButton`, `ListRow`, `Panel`, `MediaSlot`, `BottomSheet` and `BottomSheetOption`, `ToastProvider` and `useToast`, `EmptyState`, `Skeleton`, `Spinner`, `ProgressBar`, `InkActivityIndicator`, `StatusTicker`, `FloatingTabBar`, `StickyFooter` (SPEC 17.6 CTA footer, lifted by the keyboard).
- Every touchable is a `PressableScale` (React Native `Animated` spring, light haptic on press-in). Cards have no shadows; only the tab bar, floating actions and the sheet do.
- `ToastProvider` is mounted in `src/app/providers.tsx`; call `useToast().success(...)`, `.error(...)` or `.show(...)` from any screen.

## Auth

`src/features/auth` holds the whole login flow, `src/state/auth.ts` the in-memory session.

1. **Login screen**: the store domain is normalized with `normalizeShopDomain` and validated with `isValidShopDomain` (field error on failure).
2. A PKCE pair is created with `expo-crypto` (32 random bytes as the verifier, base64url SHA-256 as the challenge).
3. `expo-web-browser` opens `${EXPO_PUBLIC_API_BASE_URL}/auth/shopify/start?shop=...&challenge=...` and waits for `retailerstudio://auth?code=...`. Closing the browser is silent.
4. `POST /api/v1/auth/exchange` trades the code and verifier for the session. The access token stays in memory; the refresh token is saved in `expo-secure-store`.
5. **App start**: the auth gate renders nothing until `bootstrapAuth()` has traded the stored refresh token for a new session. A rejected token is deleted; a network failure keeps it and shows Login.
6. **401**: the API client refreshes once through a shared in-flight promise and retries the request once. A rejected refresh signs the user out. Rotated refresh tokens are written to secure storage on every change.
7. **Log out** (Account): `POST /api/v1/auth/logout`, then the session, the stored token, the query cache and the generation draft are cleared, even if the server call fails.
