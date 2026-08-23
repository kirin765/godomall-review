# TODO

## Paid Version

- [ ] Register the app as a NHN Commerce `판매앱` or convert the existing private app.
- [ ] Configure `판매정보`: payment type `인앱결제`, price, billing period, free trial/free features, refund policy, product information disclosure, support contact, and manual.
- [ ] Implement platform-aware API adapters for 고도몰 and 샵바이 before enabling paid access.
- [ ] Add `GET /app-installed/status` checks for the current platform and mall.
- [ ] Add `PUT /app-installed/extend` after an NHN app-store payment is completed.
- [ ] Store platform, solution type, and app installation identity in the signed session.
- [ ] Replace the hardcoded `paid = false` quota decision with app-installation expiry checks.
- [ ] Keep usage history after uninstall; do not reset the free quota on reinstall because NHN free trials are available only once.
- [ ] Add paid expiry, payment, expired, uninstall, reinstall, and refund handling to the UI and webhook flow.
- [ ] Submit the 판매앱 review request with test access, supported platform details, payment instructions, screenshots, privacy policy, and support information.
- [ ] Verify both 고도몰 and 샵바이 flows after approval: launch, preview, payment, extension, paid import, expiry, uninstall, and reinstall.

References:

- https://workspace.godo.co.kr/guide/app/dev
- https://workspace.godo.co.kr/guide/app/dev/development
- https://workspace.godo.co.kr/guide/app/dev/evaluation
- https://server-docs.shopby.co.kr/?url.primaryName=workspace/
- https://shopby-help.nhn-commerce.com/guide/app/app-store.md
