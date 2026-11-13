# Buzz 대화 카드

에이전트의 질문·선택지와 작업 결과를 Buzz 대화 안에서 읽기 쉬운 카드로 표시합니다.
회사 업무 코드, 대화, 계정·로그인 정보는 포함하지 않습니다.

## 설치

Buzz 설정 → Plugins → Manage plugins → Add → Git에서 아래 주소를 입력합니다.

```
https://github.com/snaps-corp/buzz-conversation-cards.git
```

브랜치는 `main`, 플러그인 폴더는 `plugin`입니다. 표시되는 접근 권한을 확인한 뒤 Install plugin을 누릅니다.
GitHub 계정 로그인은 필요 없습니다. Plugins 메뉴와 Git 업데이트 기능이 있는 공식 Buzz 데스크톱 앱이 필요합니다.

## 이미 폴더로 설치했다면 (한 번만)

1. 기존 플러그인에서 Source folder를 확인해 `folder` 설치인지 확인합니다.
2. 기존 **Buzz 대화 카드**를 Delete합니다. 플러그인만 제거하며 계정·대화는 삭제하지 않습니다.
3. 위 Git 주소에서 같은 플러그인을 설치합니다. 개인키를 입력하거나 커뮤니티를 다시 가입할 필요는 없습니다.

## 다음 업데이트부터

앱에서 새 버전 알림이 보이면 **Update and reload**를 누릅니다. 다시 ZIP을 받을 필요가 없습니다.
자동 확인이 꺼져 있으면 플러그인 메뉴의 **Check for updates automatically**를 켭니다.
공식 앱은 시작할 때와 앱이 보이는 동안 약 한 시간 간격으로 Git을 확인합니다. 즉시 강제 설치되지는 않습니다.
새 권한을 요구하는 업데이트는 별도 확인이 필요합니다. 설치된 앱 버전에 따라 메뉴가 다를 수 있습니다.

## 배포 관리

`tools/sync.py`는 공개 운영 설치 패키지 하나에서 `manifest.json`, `plugin.js`, `VERSION`만 가져옵니다.
15분 간격 예약 또는 Actions의 Run workflow로 확인하며 GitHub 예약 실행은 지연될 수 있습니다.
운영 배포 전 코드나 회사 저장소 이력을 복사하지 않습니다. 다운로드/검증 실패 시 기존 버전이 유지됩니다.
동일 버전의 내용 변경과 버전 하향은 거절합니다. 롤백은 관리자가 검토 후 별도로 처리합니다.
PR의 CI·배포와 공개 저장소의 반영은 별도이며, Actions 결과와 plugin/VERSION으로 확인하세요.

[공식 Buzz 플러그인 안내](https://github.com/block/buzz-app/blob/main/docs/plugin-architecture.md#git-plugin-updates)
