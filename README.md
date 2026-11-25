# 진실한숲 통독

진실한숲교회 2027년 통독을 위한 '오늘 화면' 시안이다. 날마다 읽을 본문과 가이드, 눈여겨볼 절, 나눔 질문을 한 화면에 보여 준다. 지금은 2027년 1월분만 들어 있고, 읽음 표시와 나눔, 질문은 각자의 기기에만 저장된다.

## 구성

- `index.html`: 화면 전체(HTML, CSS, 스크립트 한 파일)
- `data/january.json`: 1월 일정과 가이드. 성경 본문은 들어 있지 않고, 눈여겨볼 절도 위치(책, 장, 절)만 적혀 있다.
- `fonts/`: 리디바탕, Pretendard 웹 글꼴과 각 라이선스 파일
- `supabase/functions/passage/index.ts`: 본문 중계 함수의 소스. Supabase 프로젝트 `jinsup-tongdok`에 배포되어 있다.

## 본문

앱 안의 본문은 현대인의 성경(Korean Living Bible, Biblica, Inc.)이다. Biblica Fast-Track Bible License v1에 따라 YouVersion Platform API로 받아 쓰며, 이 저장소에는 성경 본문을 넣지 않는다. 화면은 다음 조건을 지키도록 만들었다.

- 본문은 Supabase 함수를 거쳐 한 번에 한 장씩만 받아 보여 준다. YouVersion App Key는 함수의 비밀값(`YVP_APP_KEY`)으로만 두고 화면 코드에는 넣지 않는다.
- 받은 본문은 브라우저 메모리에만 잠시 두고(최대 두 장) 기기나 서버에 저장하지 않는다.
- 소제목과 각주를 받은 그대로 보여 주고, 각주는 눌러서 열 수 있다.
- 본문을 보여 줄 때마다 API가 내려 주는 저작권 표시와 Biblica 웹사이트 링크를 함께 보여 준다.

화면 코드에 들어 있는 Supabase 키는 공개용(publishable) 키다. 지금은 이 키만 있으면 누구나 함수를 부를 수 있으므로, 출시 전에는 교인 로그인을 확인하는 방식으로 바꿔야 한다.

## 글꼴

리디바탕(리디주식회사 제공, SIL Open Font License 1.1)과 Pretendard(SIL Open Font License 1.1)를 쓴다. 라이선스 전문은 `fonts/` 안에 있다.
