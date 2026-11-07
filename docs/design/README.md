# Design references

References approved in [issue #2](https://github.com/iefnaf/mdshare/issues/2), originally supplied by the `design-assets` branch.

- `things-ui-ref.jpg`: spacing and quiet sidebar reference for host and guest.
- `logo-e-constellation.jpg`: approved Logo E, three pastel dots joined by arcs. Logo F is not used.
- `src/assets/logo-e.png`: 512 px PNG converted directly from Logo E, used for app chrome, Dock and the guest favicon. The guest build emits a content-hashed copy.

Regenerate the app asset on macOS from the repository root:

```sh
sips -s format png -Z 512 docs/design/logo-e-constellation.jpg --out src/assets/logo-e.png
```
