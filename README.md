# Level Up Yourself

LAON 선도학교 영어 공개수업의 **Five-Level Challenge**를 웹앱으로 구현한 학생 자기보고 · 교사 종합 대시보드입니다.

학생은 자신의 기기에서 미션 통과를 바로 보고하고, 교사는 개별 성취, 진도, 반별 현황, 단원별 현황을 그래프로 확인할 수 있습니다.

## 주요 기능

### 학생 모드
- 시작 화면에서 **학생** 선택 후 반 · 이름 · 개인 입장 코드로 로그인
- 개인 코드가 일치하는 학생 본인의 기록에만 접근 가능
- L7–L12 단원별 미션 보드
- BRONZE → SILVER → GOLD → PLATINUM → DIAMOND 5단계 도전
- 각 단계 통과 즉시 `통과 보고` 저장
- DIAMOND 자율 프로젝트(WT, PT, V, SP, TM) 개별 선택
- PLS(플랭스쿨), RG(리딩게이트) 단원 의무 · 가정 학습 체크
- 우리 반 레이스와 전체 진도 확인

### 교사 모드
- 시작 화면에서 **교사** 선택 후 교사 입장 코드로 로그인
- **입장 코드**: 학생별 개인 코드 확인 · 복사 · CSV 다운로드 · 재발급
- **종합**: 전체 KPI, 반별 레벨업 경쟁, 학생 레벨 분포, 단원별 추이, 성장 리더보드, 최근 학생 보고
- **개별**: 학생별 최고 레벨, 4단계 성취, 전체 진도, L7–L12 단원별 도달, 상세 미션 매트릭스
- **반별**: 반별 순위, 반 × 단원 히트맵, 선택 반의 미션별 달성률과 지원 필요 학생
- **단원별**: 단원별 KPI, 미션별 달성률, 반별 경쟁, 반 × 미션 히트맵, 상위 · 지원 필요 학생
- CSV 다운로드 (학생 × 단원 × 11개 미션)
- 20초 간격 실시간 동기화

## 실행 방법

Node.js 18 이상이 필요합니다. 별도 패키지 설치(npm install)는 필요하지 않습니다.

```powershell
cd C:\Users\USER\Downloads\LAON_LevelUp_App
node local-server.js
```

또는 `start.bat`을 더블클릭하면 서버 실행과 브라우저 접속이 한 번에 이루어집니다. 바탕화면의 `LAON 레벨업 앱` 바로가기도 같은 역할을 합니다. 서버 콘솔 창을 닫으면 서버가 종료됩니다.

브라우저에서 접속:

- 교사 PC: `http://localhost:3000`
- 학생 기기: 서버 실행 시 콘솔에 표시되는 `http://<내 PC의 LAN IP>:3000`

학생 기기와 교사 PC가 같은 Wi-Fi에 연결되어 있어야 합니다. Windows 방화벽이 Node.js의 네트워크 접속을 차단하면 허용해 주세요.

### 입장 코드

- **교사 입장 코드**는 서버를 처음 실행할 때 자동 생성되어 콘솔에 표시되고, `data/auth.json`에 저장됩니다.
- **학생 개인 코드**는 교사 로그인 후 `입장 코드` 탭에서 확인할 수 있습니다.
- 학생은 반 · 이름 · 개인 코드를 모두 입력해야 하며, 로그인 후에는 자신의 기록만 조회·수정할 수 있습니다.
- 코드를 잊어버린 학생은 교사가 `입장 코드` 탭에서 재발급할 수 있습니다. 이전 코드는 즉시 무효화됩니다.
- `data/auth.json`은 개인정보 보호를 위해 `.gitignore`에 포함되어 있습니다. 저장소에는 올라가지 않습니다.

## Vercel 배포

- 공개 데모: https://laon-level-up-app-a5ad.vercel.app/
- 공개 데모 교사 코드: `DEMO-2026`
- 학생 개인 코드는 교사 로그인 후 `입장 코드` 탭에서 확인할 수 있습니다.
- Vercel에서는 `api/` 폴더가 서버리스 API로 동작하고 `public/` 폴더가 정적 사이트로 배포됩니다.
- 공개 데모는 익명 공유 저장소(MantleDB)를 사용해 여러 기기와 서버리스 인스턴스에서 학생 보고가 공유됩니다.
- 운영 환경에서는 Vercel KV(Upstash Redis)를 연결하고 `KV_REST_API_URL`, `KV_REST_API_TOKEN` 환경 변수를 설정하는 것을 권장합니다. 또는 `LAON_STORE_URL`로 별도 저장소를 지정할 수 있습니다.
- 운영 환경에서는 `TEACHER_CODE`, `LAON_CODE_SECRET`, `LAON_TOKEN_SECRET` 환경 변수를 반드시 별도로 설정하세요.

## 데이터

- `seed.json` (프로젝트 루트, 웹으로 직접 공개되지 않음)
  - `2026 영어 평가 기록 5학년 2학기.xlsx`에서 추출한 137명 학생, 6개 반, L7–L12 단원, 11개 미션의 기초 달성 기록
  - `LAON 선도학교 영어 공개수업 지도안 및 안내서.docx`의 Five-Level Challenge 기준 반영
  - API를 통해서만 접근하며, 학생에게는 본인 기록만 전송됩니다.
  - 공개 저장소에는 학생 이름을 `학생001` 형식의 익명 ID로 바꾼 데이터가 포함됩니다.
- `data/seed-private.json` (선택, gitignore)
  - 실제 학생 이름이 필요한 학교 현장에서만 사용하는 로컬 비공개 데이터입니다.
  - 이 파일이 있으면 서버가 공개용 `seed.json` 대신 자동으로 이 파일을 사용합니다.
- `data/reports.json`
  - 학생이 앱에서 보고한 기록이 저장되는 런타임 파일
  - `.gitignore`에 포함되어 저장소에는 올라가지 않습니다.

### 미션 코드

| 코드 | 의미 | 레벨 |
| --- | --- | --- |
| VC | Vocabulary Test | BRONZE |
| ST | Sentence Dictation | SILVER |
| RP | Role-Play Acting | GOLD |
| RP+ | Role-Play Master | PLATINUM |
| WT | Writing | DIAMOND |
| PT | Presentation | DIAMOND |
| V | Video Making | DIAMOND |
| SP | Self Project | DIAMOND |
| TM | Teaching Master | DIAMOND |
| PLS | Plang School | 단원 의무 과제 |
| RG | Reading Gate | 가정 학습 |

DIAMOND는 WT, PT, V, SP, TM 중 1개 이상을 완성하면 도달합니다. PLS와 RG는 레벨 산정과 별개로 표시됩니다.

## 파일 구조

```text
LAON_LevelUp_App/
├─ local-server.js        # 로컬 실행용 Node.js 서버 (파일 저장 기반)
├─ api/                   # Vercel 서버리스 API 함수
├─ lib/laon.js            # Vercel API 공통 로직
├─ seed.json              # 공개용 익명 데이터 (웹 비공개, API 전용)
├─ package.json
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js              # 학생/교사 화면, 집계, 차트, CSV
└─ data/                  # reports.json, auth.json, seed-private.json (gitignore)
```

## 참고

- 교사용 대시보드도 교사 입장 코드가 있어야 접속할 수 있습니다.
- 공개 저장소의 `seed.json`은 학생 이름을 익명화한 데이터입니다. 실제 이름은 `data/seed-private.json`에만 두고 Git에 올리지 마세요.
- `data/auth.json`에는 교사·학생 입장 코드가 저장됩니다. 절대 외부에 공유하거나 저장소에 올리지 마세요.
- L9 단원명은 원본 지도안에 명시되어 있지 않아 교과서 단원 흐름에 맞춰 `What Do You Do in Your Free Time?`으로 보완했습니다. 필요하면 `seed.json`의 `lessons`에서 수정할 수 있습니다.
