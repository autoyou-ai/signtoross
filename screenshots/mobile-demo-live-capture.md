# Live native AutoYou companion capture

This folder includes a continuous native Android capture for the AutoYou
companion reference used by SignToROSS.

Source conditions:

- current AutoYou Android debug APK rebuilt from the AutoYou checkout
- disposable `Medium_Phone` Android emulator
- local AutoYou Lite fixture on loopback
- synthetic provider replies only
- no sign-in, payment, production account, or personal data

The capture is a real app interaction:

1. an active connection is visible
2. the chat shows an existing local exchange
3. the operator types `Keep this private`
4. the message is sent
5. the reply arrives through the local session
6. the view returns to the connection status

Files:

- `autoyou-mobile-demo-live-native.mp4` is the 45-second uncaptioned master,
  1080 x 2400, about 30 fps
- `autoyou-mobile-demo-live-vertical.mp4` is the 36-second portrait social cut,
  1080 x 2400, about 30 fps, with captions inlaid over the app
- `autoyou-mobile-demo-live-poster.png` is the poster frame
- `mobile-demo-live-captions.ass` is the editable caption track

The footage is continuous. It has no slide cards, zoom pans, crossfades, or
assembled screenshot sequence. This is an AutoYou companion reference. It does
not show a completed SignToROSS envelope or signature. The local fixture is not
`test.autoyou.me`.
