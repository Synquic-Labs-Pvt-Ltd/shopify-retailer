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

With `EXPO_PUBLIC_API_MOCK=true` the API client is replaced by the fixtures in `src/api/mock.ts`.

- Login keeps its normal validation but skips the browser: the domain field starts as `mock-store`, a login code is fabricated, and the mock `POST /auth/exchange` returns a session for "Mock Store". Login, tabs, Account and Log out all work without a backend.
- The mock `refresh`, `logout` and `me` are served too, so the refresh token kept in secure storage restores the session on the next app start.
- Staged upload targets are `mock://staged-upload`: the upload feature must skip the multipart POST in mock mode.
- Restart Metro after changing `.env`; Expo inlines `EXPO_PUBLIC_*` values at bundle time.

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
