export const SAMPLES = [
    {
        id: "snow",
        file: "default.webp",
        alt: "눈 오는 도시",
        author: "qiaominxu 橋茗旭",
        profile: "https://pixabay.com/users/qiaominxu_橋茗旭-18717949/",
        aiGenerated: false,
    },
    {
        id: "desk",
        file: "desk.webp",
        alt: "책상 앞의 분홍 머리 일러스트",
        author: "qiaominxu_橋茗旭",
        profile: "https://pixabay.com/users/qiaominxu_橋茗旭-18717949/",
        aiGenerated: true,
    },
    {
        id: "cute",
        file: "cute.webp",
        alt: "모자와 고양이가 있는 일러스트",
        author: "Sushi_musume_jk",
        profile: "https://pixabay.com/users/sushi_musume_jk-42518915/",
        aiGenerated: true,
    },
    {
        id: "metal",
        file: "metal.webp",
        alt: "금속 우리 안의 크롬 구",
        author: "TheDigitalArtist",
        profile: "https://pixabay.com/users/thedigitalartist-202249/",
        page: "https://pixabay.com/illustrations/chrome-3d-render-metal-silver-649761/",
        license: "Pixabay Content License",
        aiGenerated: false,
    },
];

export const DEFAULT_SAMPLE = SAMPLES[0];
export const LAYER_SAMPLE = SAMPLES.find((sample) => sample.id === "metal");
