// GLOBAL STATE & PERSISTENT IN-MEMORY STORE
const firebaseConfig = {
    apiKey: 'AIzaSyBwTQpzYj_ylfDVNLnLIhS_Db9y0560O5Y',
    authDomain: 'mathlearn-b766d.firebaseapp.com',
    projectId: 'mathlearn-b766d',
    storageBucket: 'mathlearn-b766d.firebasestorage.app',
    messagingSenderId: '693641664602',
    appId: '1:693641664602:web:89b440a62a9c7bd345e063',
    measurementId: 'G-B3F0SPSMPW'
};

const DEFAULT_ROLE = 'student';
const LEGAL_ROLES = new Set(['student', 'teacher', 'admin']);
async function saveLearningContentToFirestore() {
    if (!isFirebaseReady() || !firebaseAuth.currentUser) {
        throw new Error('Pengguna belum login ke Firebase.');
    }

    await firebaseDb.collection('appData').doc('learningContent').set({
        classes: state.classes,
        materiList: state.materiList,
        taskList: state.taskList,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}
function normalizeRole(role) {
    const normalized = String(role || '').trim().toLowerCase();
    if (normalized === 'siswa') return 'student';
    if (normalized === 'guru') return 'teacher';
    return normalized;
}

let firebaseReady = false;
let firebaseAuth = null;
let firebaseDb = null;
let submissionsUnsubscribe = null;
let studentCameraStream = null;
let studentCameraType = null;
let teacherQuestionCameraStream = null;
let teacherQuestionCameraInput = null;

function initializeFirebaseClient() {
    if (!window.firebase || !window.firebase.apps) {
        firebaseReady = false;
        firebaseAuth = null;
        firebaseDb = null;
        return false;
    }

    if (firebase.apps.length === 0) {
        const hasPlaceholderConfig = Object.values(firebaseConfig).some(value => !value || String(value).includes('YOUR_'));
        if (hasPlaceholderConfig) {
            console.warn('Firebase config belum diisi. Sistem berjalan di mode demo lokal untuk prototipe.');
            firebaseReady = false;
            firebaseAuth = null;
            firebaseDb = null;
            return false;
        }
        firebase.initializeApp(firebaseConfig);
    }

    firebaseReady = true;
    firebaseAuth = firebase.auth();
    firebaseDb = firebase.firestore();
    return true;
}

initializeFirebaseClient();

const defaultState = {
    currentUser: null,
    users: [
        { id: 1, nama: 'Admin Web', email: 'admin@mathlearn.id', password: 'admin123', role: 'admin', token: 'ADMIN-ROOT', deviceId: '', deviceLocked: false },
        { id: 2, nama: 'Guru Matematika', email: 'guru@mathlearn.id', password: 'guru123', role: 'teacher', token: 'GURU-001', deviceId: '', deviceLocked: false },
        { id: 3, nama: 'Siswa Kelas A', email: 'siswa@mathlearn.id', password: 'siswa123', role: 'student', token: 'SISWA-001', deviceId: '', deviceLocked: false }
    ],
    classes: [
        { id: 1, nama: 'Kelas A - Pythagoras', deskripsi: 'Kelas utama pembelajaran Teorema Pythagoras', materi: [] }
    ],
    emailLogs: [],
    notifications: [],
    activeTab: 'materi',
    studentCheatLogs: [],
    materiList: [
        { id: 1, judul: "Konsep Dasar Teorema Pythagoras", deskripsi: "Teorema Pythagoras menyatakan a² + b² = c² pada segitiga siku-siku.", yt: "https://youtube.com", file: "", classId: 1 }
    ],
    taskList: {
        Lkpd: [
            { id: 101, title: "Pertemuan 1: Eksplorasi Tangga", content: "Sebuah tangga panjangnya 5 meter disandarkan pada tembok. Jarak ujung bawah tangga ke tembok adalah 3 meter. Hitunglah tinggi tembok yang dicapai oleh tangga!", openDate: "2023-01-01T07:00", closeDate: "2030-12-31T23:59", classId: 1 }
        ],
        Latihan: [
            { id: 201, title: "Latihan Materi Pythagoras Dasar", content: "Hitunglah panjang diagonal persegi panjang jika panjangnya 8 cm dan lebarnya 6 cm!", openDate: "2023-01-01T07:00", closeDate: "2030-12-31T23:59", classId: 1 }
        ],
        Evaluasi: [
            { id: 301, title: "Evaluasi Bab 1 Komprehensif", content: "Sebuah tiang bendera setinggi 12 meter berdiri tegak. Sebuah tali diikatkan dari puncak tiang ke tanah sejauh 5 meter dari kaki tiang. Berapakah panjang tali tersebut?", openDate: "2023-01-01T07:00", closeDate: "2030-12-31T23:59", classId: 1 }
        ]
    },
    studentSubmissions: []
};

// Load initial state from LocalStorage or default
let state = JSON.parse(localStorage.getItem('mathlearn_state')) || defaultState;
state.users = Array.isArray(state.users) ? state.users : defaultState.users;
state.classes = Array.isArray(state.classes) ? state.classes : defaultState.classes;
state.emailLogs = Array.isArray(state.emailLogs) ? state.emailLogs : [];
state.notifications = Array.isArray(state.notifications) ? state.notifications : [];
state.users.forEach(user => { user.deviceId = user.deviceId || ''; user.deviceLocked = Boolean(user.deviceLocked); });
let activeStudentQuestion = {};
const studentTaskTimers = {};
const studentNotificationPageSize = 4;
let studentNotificationPage = 0;

Object.keys(state.taskList).forEach(type => {
    state.taskList[type] = state.taskList[type].map(task => ({
        ...task,
        questions: Array.isArray(task.questions) && task.questions.length > 0
            ? task.questions
            : [task.content || '']
    }));
});

function migrateLegacyDefaultClassContent() {
    const defaultClassId = defaultState.classes[0].id;
    state.materiList = state.materiList.map(item => {
        const defaultItem = defaultState.materiList.find(candidate => candidate.id === item.id);
        return !item.classId && defaultItem && item.judul === defaultItem.judul
            ? { ...item, classId: defaultClassId }
            : item;
    });
    Object.keys(defaultState.taskList).forEach(type => {
        state.taskList[type] = state.taskList[type].map(item => {
            const defaultItem = defaultState.taskList[type].find(candidate => candidate.id === item.id);
            return !item.classId && defaultItem && item.title === defaultItem.title
                ? { ...item, classId: defaultClassId }
                : item;
        });
    });
}

migrateLegacyDefaultClassContent();

function saveState() {
    const persistedState = {
        ...state,
        studentSubmissions: state.studentSubmissions.map(submission => ({
            ...submission,
            attachments: Array.isArray(submission.attachments)
                ? submission.attachments.map(attachment => ({
                    ...attachment,
                    url: attachment.url?.startsWith('data:image/') ? '' : attachment.url
                }))
                : submission.attachments
        }))
    };
    localStorage.setItem('mathlearn_state', JSON.stringify(persistedState));
}

async function saveLearningContent() {
    saveState();
    if (!isFirebaseReady() || !firebaseAuth.currentUser) return null;

    const content = {
        classes: state.classes,
        materiList: state.materiList,
        taskList: state.taskList,
        notifications: state.notifications
    };

    if (new Blob([JSON.stringify(content)]).size > 900 * 1024) {
        customAlert('Konten terlalu besar untuk satu dokumen Firestore. Kurangi ukuran/jumlah foto soal atau simpan foto di Firebase Storage.', 'Konten Terlalu Besar');
        return false;
    }

    try {
        await firebaseDb.collection('appData').doc('learningContent').set(content, { merge: true });
        return true;
    } catch (error) {
        console.error('Gagal menyinkronkan konten ke Firestore:', error);
        customAlert('Perubahan tersimpan di perangkat ini, tetapi gagal disinkronkan. Periksa login, Firestore Rules, dan koneksi internet.', 'Sinkronisasi Gagal');
        return false;
    }
}

async function loadLearningContent() {
    if (!isFirebaseReady() || !firebaseAuth.currentUser) return false;

    try {
        const snapshot = await firebaseDb.collection('appData').doc('learningContent').get();
        if (!snapshot.exists) {
            const role = normalizeRole(state.currentUser?.role);
            if (role === 'teacher' || role === 'admin') await saveLearningContent();
            return false;
        }

        const content = snapshot.data();
        if (Array.isArray(content.classes)) state.classes = content.classes;
        if (Array.isArray(content.materiList)) state.materiList = content.materiList;
        if (Array.isArray(content.notifications)) state.notifications = content.notifications;
        if (content.taskList && typeof content.taskList === 'object') {
            ['Lkpd', 'Latihan', 'Evaluasi'].forEach(type => {
                if (Array.isArray(content.taskList[type])) {
                    state.taskList[type] = content.taskList[type].map(task => ({
                        ...task,
                        questions: Array.isArray(task.questions) && task.questions.length > 0
                            ? task.questions
                            : [task.content || '']
                    }));
                }
            });
        }
        migrateLegacyDefaultClassContent();
        saveState();
        return true;
    } catch (error) {
        console.error('Gagal memuat konten dari Firestore:', error);
        customAlert('Konten Firestore gagal dimuat. Data lokal perangkat ini tetap digunakan.', 'Gagal Memuat Konten');
        return false;
    }
}

async function loadStudentSubmissions() {
    if (!isFirebaseReady() || !firebaseAuth.currentUser) return false;

    try {
        const submissionsRef = firebaseDb.collection('submissions');
        const role = normalizeRole(state.currentUser?.role);
        const query = role === 'teacher' || role === 'admin'
            ? submissionsRef
            : submissionsRef.where('studentUid', '==', firebaseAuth.currentUser.uid);
        let snapshot = await query.get();

        if (role === 'student') {
            const email = String(state.currentUser?.email || '').trim().toLowerCase();
            const legacySubmissions = state.studentSubmissions.filter(submission =>
                !submission.studentUid && email && String(submission.email || '').trim().toLowerCase() === email
            );
            const existingIds = new Set(snapshot.docs.map(doc => doc.id));
            for (const submission of legacySubmissions) {
                const id = String(submission.id);
                if (existingIds.has(id)) continue;
                await submissionsRef.doc(id).set({
                    ...submission,
                    studentUid: firebaseAuth.currentUser.uid,
                    role: 'student',
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                existingIds.add(id);
            }
            if (legacySubmissions.length) snapshot = await query.get();
        }

        state.studentSubmissions = snapshot.docs.map(doc => {
            const numericId = Number(doc.id);
            return { ...doc.data(), id: Number.isSafeInteger(numericId) ? numericId : doc.id };
        });
        saveState();
        return true;
    } catch (error) {
        console.error('Gagal memuat kiriman siswa:', error);
        customAlert('Hasil pengerjaan gagal dimuat dari server. Periksa koneksi dan Firestore Rules.', 'Gagal Memuat Kiriman');
        return false;
    }
}

function watchStudentSubmissions() {
    if (!isFirebaseReady() || !firebaseAuth.currentUser) return;
    if (submissionsUnsubscribe) submissionsUnsubscribe();

    const role = normalizeRole(state.currentUser?.role);
    const submissionsRef = firebaseDb.collection('submissions');
    const query = role === 'teacher' || role === 'admin'
        ? submissionsRef
        : submissionsRef.where('studentUid', '==', firebaseAuth.currentUser.uid);

    submissionsUnsubscribe = query.onSnapshot(snapshot => {
        state.studentSubmissions = snapshot.docs.map(doc => {
            const numericId = Number(doc.id);
            return { ...doc.data(), id: Number.isSafeInteger(numericId) ? numericId : doc.id };
        });
        saveState();
        if (role === 'teacher' || role === 'admin') renderGuruView();
        else renderSiswaView();
    }, error => {
        console.error('Gagal memantau kiriman siswa:', error);
    });
}

async function saveSubmissionToFirestore(submission) {
    if (!isFirebaseReady() || !firebaseAuth.currentUser) return false;

    const submissionRef = firebaseDb.collection('submissions').doc(String(submission.id));
    const payload = {
        ...submission,
        studentUid: firebaseAuth.currentUser.uid,
        role: 'student',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (new Blob([JSON.stringify(payload)]).size > 800 * 1024) {
        throw new Error('Ukuran foto gabungan terlalu besar. Kurangi jumlah foto atau unggah satu per satu.');
    }
    await submissionRef.set(payload);
    submission.id = submissionRef.id;
    return true;
}

async function updateSubmissionInFirestore(submissionId, updates) {
    if (!isFirebaseReady() || !firebaseAuth.currentUser) return false;
    await firebaseDb.collection('submissions').doc(String(submissionId)).update(updates);
    return true;
}

async function deleteSubmissionFromFirestore(submissionId) {
    if (!isFirebaseReady() || !firebaseAuth.currentUser) return false;
    await firebaseDb.collection('submissions').doc(String(submissionId)).delete();
    return true;
}

function isFirebaseReady() {
    return firebaseReady && !!firebaseAuth && !!firebaseDb;
}

function safePageInit(expectedRole) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    try {
        checkExistingSession(expectedRole);
    } catch (error) {
        console.error('Gagal menginisialisasi halaman:', error);
        const modal = document.getElementById('customModal');
        if (modal) {
            customAlert('Halaman gagal dimuat. Periksa konfigurasi Firebase dan muat ulang halaman.', 'Error Aplikasi');
        }
    }
}

async function getUserProfileFromFirestore(uid) {
    if (!isFirebaseReady()) return null;
    const doc = await firebaseDb.collection('users').doc(uid).get();
    return doc.exists ? doc.data() : null;
}

function persistSessionProfile(profile, uid, email, displayName) {
    const role = profile && LEGAL_ROLES.has(normalizeRole(profile.role)) ? normalizeRole(profile.role) : DEFAULT_ROLE;
    const savedClassId = state.currentUser?.id === uid ? state.currentUser.classId : undefined;
    const classId = profile?.classId || savedClassId;
    const normalized = {
        id: uid,
        role,
        email: email || profile?.email || '',
        nama: displayName || profile?.name || profile?.displayName || email || 'Pengguna',
        deviceId: getDeviceId(),
        ...(classId ? { classId: Number(classId) } : {})
    };
    state.currentUser = normalized;
    saveState();
    return normalized;
}

function routeByRole(role) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const normalizedRole = normalizeRole(role);
    const goTo = (page) => {
        const target = page.startsWith('/') ? page : `./${page}`;
        window.location.assign(target);
    };
    if (normalizedRole === 'teacher') {
        goTo('dashboard_guru.html');
        return;
    }
    if (normalizedRole === 'admin') {
        goTo('dashboard_admin.html');
        return;
    }
    if (normalizedRole === 'student') {
        goTo('dashboard_siswa.html');
        return;
    }
    customAlert('Akun Anda belum memiliki role yang valid. Hubungi administrator untuk aktivasi.', 'Akses Ditolak');
}

async function ensureAuthorizedDashboard(requiredRole) {
    const user = isFirebaseReady() && firebaseAuth ? firebaseAuth.currentUser : null;
    const localUser = state.currentUser;

    if (!user && !localUser) {
        window.location.assign('./halaman_login_registrasi.html');
        return false;
    }

    if (user) {
        const profile = await getUserProfileFromFirestore(user.uid);
        const profileRole = normalizeRole(profile?.role);
        if (!profile || !profileRole || !LEGAL_ROLES.has(profileRole)) {
            customAlert('Akun belum aktif atau role tidak valid. Hubungi administrator.', 'Akses Ditolak');
            if (firebaseAuth) {
                await firebaseAuth.signOut().catch(() => {});
            }
            window.location.assign('./halaman_login_registrasi.html');
            return false;
        }

        if (profileRole !== normalizeRole(requiredRole)) {
            customAlert('Anda tidak memiliki izin untuk membuka dashboard ini.', 'Akses Ditolak');
            routeByRole(profileRole);
            return false;
        }

        persistSessionProfile({ ...profile, role: profileRole }, user.uid, user.email, profile.name || user.email);
        return true;
    }

    if (normalizeRole(localUser?.role) !== normalizeRole(requiredRole)) {
        customAlert('Anda tidak memiliki izin untuk membuka dashboard ini.', 'Akses Ditolak');
        routeByRole(localUser?.role || 'student');
        return false;
    }

    return true;
}

async function handleFirebaseLogin(email, password) {
    if (!isFirebaseReady()) {
        throw new Error('Firebase belum siap.');
    }

    const credential = await firebaseAuth.signInWithEmailAndPassword(email, password);
    const uid = credential.user.uid;
    const profile = await getUserProfileFromFirestore(uid);
    const profileRole = normalizeRole(profile?.role);

    if (!profile || !profileRole || !LEGAL_ROLES.has(profileRole)) {
        await firebaseAuth.signOut();
        customAlert('Akun belum aktif atau role tidak ditemukan. Hubungi admin untuk aktivasi akun.', 'Login Ditolak');
        return;
    }

    persistSessionProfile({ ...profile, role: profileRole }, uid, credential.user.email, profile.name || credential.user.displayName || credential.user.email);
    routeByRole(profileRole);
}

async function handleFirebaseStudentRegistration(name, email, password) {
    if (!isFirebaseReady()) {
        throw new Error('Firebase belum siap.');
    }

    const credential = await firebaseAuth.createUserWithEmailAndPassword(email, password);
    const uid = credential.user.uid;
    const profile = {
        name: name || 'Siswa Baru',
        email: email,
        role: 'student',
        classIds: [],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    await firebaseDb.collection('users').doc(uid).set(profile);
    persistSessionProfile(profile, uid, email, profile.name);
    routeByRole('student');
}

function addStudentNotification(type, title, classId, contentId = null, contentType = type) {
    state.notifications.unshift({
        id: Date.now(),
        type,
        title,
        classId: Number(classId) || null,
        contentId: contentId == null ? null : Number(contentId),
        contentType,
        date: new Date().toISOString()
    });
    state.notifications = state.notifications.slice(0, 50);
    studentNotificationPage = 0;
}

function removeContentNotification(contentId, contentType) {
    state.notifications = state.notifications.filter(notification => !(Number(notification.contentId) === Number(contentId) && notification.contentType === contentType));
}

function removeClassNotifications(classId) {
    state.notifications = state.notifications.filter(notification => Number(notification.classId) !== Number(classId));
}

function markStudentNotificationRead(notificationId) {
    const notification = state.notifications.find(item => String(item.id) === String(notificationId));
    if (!notification) return;

    const taskType = ['Lkpd', 'Latihan', 'Evaluasi'].find(type => type === notification.contentType)
        || ({ LKPD: 'Lkpd' })[notification.type];
    if (taskType) {
        switchStudentTab(taskType.toLowerCase());
        const task = state.taskList[taskType].find(item => Number(item.id) === Number(notification.contentId));
        if (task && isTaskOpen(task.openDate, task.closeDate)) openStudentTask(taskType, task.id);
        return;
    }

    dismissStudentNotification(notification.id);
    saveState();
    renderSiswaView();
    switchStudentTab('materi');
}

function changeStudentNotificationPage(direction) {
    studentNotificationPage += direction;
    renderSiswaView();
}

function getStudentNotificationDismissalKey() {
    const identity = state.currentUser?.id || state.currentUser?.email || 'student';
    return `mathlearn_dismissed_notifications_${encodeURIComponent(String(identity).toLowerCase())}`;
}

function getDismissedStudentNotificationIds() {
    try {
        const ids = JSON.parse(localStorage.getItem(getStudentNotificationDismissalKey()) || '[]');
        return new Set(Array.isArray(ids) ? ids.map(String) : []);
    } catch (error) {
        return new Set();
    }
}

function dismissStudentNotification(notificationId) {
    const dismissedIds = getDismissedStudentNotificationIds();
    dismissedIds.add(String(notificationId));
    localStorage.setItem(getStudentNotificationDismissalKey(), JSON.stringify([...dismissedIds].slice(-100)));
}

let pendingConfirmAction = null;

function customAlert(message, title = "Pemberitahuan") {
    const modalTitle = document.getElementById('modalTitle');
    const modalMessage = document.getElementById('modalMessage');
    const modalActions = document.getElementById('modalActions');
    const modal = document.getElementById('customModal');

    if (!modal) return;
    modalTitle.innerText = title;
    modalMessage.innerText = message;
    modalActions.innerHTML = `<button onclick="closeModal()" class="px-4 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700 transition">OK</button>`;
    modal.classList.remove('hidden');
}

function customConfirm(message, callback, title = "Konfirmasi", cancelLabel = "Batal", confirmLabel = "Ya, Lanjutkan") {
    const modalTitle = document.getElementById('modalTitle');
    const modalMessage = document.getElementById('modalMessage');
    const modalActions = document.getElementById('modalActions');
    const modal = document.getElementById('customModal');

    if (!modal) return;
    modalTitle.innerText = title;
    modalMessage.innerText = message;
    pendingConfirmAction = callback;
    modalActions.innerHTML = `
        <button onclick="closeModal()" class="px-4 py-2 bg-slate-200 text-slate-700 text-sm font-bold rounded-lg hover:bg-slate-300 transition">${cancelLabel}</button>
        <button onclick="executeConfirm()" class="px-4 py-2 bg-rose-600 text-white text-sm font-bold rounded-lg hover:bg-rose-700 transition">${confirmLabel}</button>
    `;
    modal.classList.remove('hidden');
}

function closeModal() {
    const modal = document.getElementById('customModal');
    if (modal) modal.classList.add('hidden');
}

function executeConfirm() {
    closeModal();
    if (typeof pendingConfirmAction === 'function') pendingConfirmAction();
}

function setAuthMode(mode) {
    const isReg = mode === 'register';
    const fieldNama = document.getElementById('fieldNamaLengkap');
    const btnSubmit = document.getElementById('btnAuthSubmit');
    const tabLogin = document.getElementById('tabAuthLogin');
    const tabReg = document.getElementById('tabAuthRegister');

    if (fieldNama) fieldNama.classList.toggle('hidden', !isReg);
    if (btnSubmit) btnSubmit.innerText = isReg ? 'Daftar Akun Siswa' : 'Masuk ke Sistem';
    if (tabLogin) tabLogin.className = !isReg ? 'flex-1 py-2 text-xs font-bold rounded-lg bg-white shadow-sm text-slate-800 transition' : 'flex-1 py-2 text-xs font-bold rounded-lg text-slate-500 hover:text-slate-800 transition';
    if (tabReg) tabReg.className = isReg ? 'flex-1 py-2 text-xs font-bold rounded-lg bg-white shadow-sm text-slate-800 transition' : 'flex-1 py-2 text-xs font-bold rounded-lg text-slate-500 hover:text-slate-800 transition';
}

function getLoginErrorMessage(error) {
    switch (error?.code) {
        case 'auth/invalid-credential':
        case 'auth/invalid-login-credentials':
        case 'auth/user-not-found':
        case 'auth/wrong-password':
            return 'Email atau kata sandi tidak cocok dengan akun Firebase Authentication.';
        case 'auth/operation-not-allowed':
            return 'Metode Email/Password belum diaktifkan di Firebase Authentication.';
        case 'auth/unauthorized-domain':
            return 'Domain Live Server belum diizinkan. Tambahkan hostname halaman ini di Authentication > Settings > Authorized domains.';
        case 'auth/network-request-failed':
            return 'Koneksi ke Firebase gagal. Periksa internet atau apakah Firebase SDK berhasil dimuat.';
        case 'auth/invalid-api-key':
            return 'API key Firebase tidak valid. Periksa firebaseConfig dan pastikan proyeknya benar.';
        case 'permission-denied':
        case 'firestore/permission-denied':
            return 'Login berhasil, tetapi Firestore menolak pembacaan profil. Periksa Firestore Security Rules.';
        default:
            return 'Login gagal. Periksa akun Firebase dan konfigurasi proyek.';
    }
}

async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = document.getElementById('inputEmail').value.trim();
    const password = document.getElementById('inputPassword').value;
    const namaInput = document.getElementById('inputNama')?.value.trim();
    const isRegistering = !document.getElementById('fieldNamaLengkap')?.classList.contains('hidden');

    if (isRegistering) {
        if (!email || !password || !namaInput) {
            customAlert('Nama lengkap, email, dan kata sandi harus diisi untuk pendaftaran siswa.', 'Pendaftaran Ditolak');
            return;
        }

        if (isFirebaseReady()) {
            try {
                await handleFirebaseStudentRegistration(namaInput, email, password);
                return;
            } catch (error) {
                console.error(error);
                customAlert('Pendaftaran siswa gagal. Pastikan email belum terpakai dan Firebase sudah dikonfigurasi.', 'Pendaftaran Ditolak');
                return;
            }
        }

        const existingUser = state.users.find(user => user.email.toLowerCase() === email.toLowerCase());
        if (existingUser) {
            customAlert('Email sudah terdaftar. Silakan masuk menggunakan akun yang sudah ada.', 'Pendaftaran Ditolak');
            return;
        }

        const newUser = {
            id: Date.now(),
            role: 'student',
            email,
            nama: namaInput,
            password,
            token: `STUDENT-${String(Date.now()).slice(-6)}`,
            tokenUsed: true,
            deviceId: getDeviceId(),
            deviceLocked: false
        };
        state.users.push(newUser);
        state.currentUser = { id: newUser.id, role: 'student', email: newUser.email, nama: newUser.nama, deviceId: newUser.deviceId };
        saveState();
        window.location.assign('./dashboard_siswa.html');
        return;
    }

    if (isFirebaseReady()) {
        try {
            await handleFirebaseLogin(email, password);
            return;
        } catch (error) {
            console.error(error);
            customAlert(`${getLoginErrorMessage(error)}\n\nKode error: ${error.code || 'tidak tersedia'}`, 'Login Ditolak');
            return;
        }
    }

    const existingUser = state.users.find(user => user.email.toLowerCase() === email.toLowerCase() && user.password === password);
    if (!existingUser) {
        customAlert('Akun tidak ditemukan atau kata sandi salah.', 'Login Ditolak');
        return;
    }

    const deviceId = getDeviceId();
    if (existingUser.deviceLocked && existingUser.deviceId && existingUser.deviceId !== deviceId) {
        customAlert('Akun ini dikunci untuk perangkat lain. Hubungi admin untuk reset device.', 'Device Ditolak');
        return;
    }

    existingUser.deviceId = existingUser.deviceId || deviceId;
    state.currentUser = { id: existingUser.id, role: existingUser.role, email: existingUser.email, nama: existingUser.nama, deviceId: existingUser.deviceId };
    saveState();
    routeByRole(existingUser.role);
}

function getDeviceId() {
    let deviceId = localStorage.getItem('mathlearn_device_id');
    if (!deviceId) {
        deviceId = `DEV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        localStorage.setItem('mathlearn_device_id', deviceId);
    }
    return deviceId;
}

function renderDashboardForRole(expectedRole) {
    const userLabel = document.getElementById('currentUserLabel');
    const roleBadge = document.getElementById('currentRoleBadge');
    const currentRole = normalizeRole(state.currentUser.role);

    if (userLabel) userLabel.innerText = state.currentUser.nama;
    if (roleBadge) roleBadge.innerText = currentRole;

    if (expectedRole && currentRole !== normalizeRole(expectedRole)) {
        routeByRole(currentRole);
        return;
    }

    if (expectedRole === 'login') {
        routeByRole(currentRole);
        return;
    }

    if (normalizeRole(expectedRole) === 'student') {
        renderSiswaView();
        switchStudentTab(getTabFromHash('materi', ['notifikasi', 'materi', 'lkpd', 'latihan', 'evaluasi', 'hasil']));
    }
    if (normalizeRole(expectedRole) === 'teacher') {
        ['Lkpd', 'Latihan', 'Evaluasi'].forEach(type => {
            const container = document.getElementById(`form${type}Questions`);
            if (container && container.children.length === 0) addQuestionField(type);
        });
        renderGuruView();
        switchTeacherTab(getTabFromHash('materi', ['kelas', 'materi', 'lkpd', 'latihan', 'evaluasi', 'review']));
    }
    if (normalizeRole(expectedRole) === 'admin') {
        renderAdminView();
    }
}

async function checkExistingSession(expectedRole) {
    if (isFirebaseReady()) {
        firebaseAuth.onAuthStateChanged(async (user) => {
            try {
                if (!user) {
                    if (!state.currentUser) {
                        if (window.location.pathname.includes('dashboard_')) {
                            window.location.assign('./halaman_login_registrasi.html');
                        }
                        return;
                    }
                    renderDashboardForRole(expectedRole);
                    return;
                }

                const profile = await getUserProfileFromFirestore(user.uid);
                const profileRole = normalizeRole(profile?.role);
                if (!profile || !LEGAL_ROLES.has(profileRole)) {
                    customAlert('Akun Anda belum siap. Hubungi admin untuk aktivasi.', 'Akses Ditolak');
                    await firebaseAuth.signOut();
                    return;
                }

                persistSessionProfile({ ...profile, role: profileRole }, user.uid, user.email, profile.name || user.email);
                if (expectedRole === 'login') {
                    routeByRole(profileRole);
                    return;
                }
                if (expectedRole && profileRole !== normalizeRole(expectedRole)) {
                    routeByRole(profileRole);
                    return;
                }

                await loadLearningContent();
                await loadStudentSubmissions();
                watchStudentSubmissions();
                renderDashboardForRole(expectedRole);
            } catch (error) {
                console.error('Gagal memeriksa sesi Firebase:', error);
                customAlert('Sesi gagal dimuat. Periksa koneksi Firebase lalu muat ulang halaman.', 'Gagal Memuat Sesi');
            }
        });
        return;
    }

    if (!state.currentUser) {
        if (window.location.pathname.includes('dashboard_')) {
            window.location.assign('./halaman_login_registrasi.html');
        }
        return;
    }

    renderDashboardForRole(expectedRole);
}

function getTabFromHash(defaultTab, allowedTabs) {
    const requestedTab = window.location.hash.replace('#', '').toLowerCase();
    return allowedTabs.includes(requestedTab) ? requestedTab : defaultTab;
}

function logout() {
    if (isFirebaseReady() && firebaseAuth.currentUser) {
        firebaseAuth.signOut().catch(() => {});
    }
    state.currentUser = null;
    saveState();
    window.location.assign('./halaman_login_registrasi.html');
}

function backupAllData() {
    const backup = {
        timestamp: new Date().toISOString(),
        materi: state.materiList,
        tasks: state.taskList,
        classes: state.classes,
        emailLogs: state.emailLogs,
        submissions: state.studentSubmissions,
        logs: state.studentCheatLogs
    };
    const serialized = JSON.stringify(backup, null, 2);
    localStorage.setItem('mathlearn_backup', serialized);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }));
    link.download = `mathlearn-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    customAlert('Backup materi, kelas, tugas, nilai, dan aktivitas pembelajaran berhasil dibuat. Data akun Firebase tidak disertakan.', 'Backup Sukses');
}

function renderAdminView() {
    const panelTitle = document.getElementById('adminDetailTitle');
    const panelContent = document.getElementById('adminDetailContent');
    const panelAction = document.getElementById('adminDetailAction');
    const navs = Array.from(document.querySelectorAll('.admin-nav'));

    if (!panelTitle || !panelContent) return;
    const selected = location.hash?.replace('#', '') || 'dashboard';
    const titles = { dashboard: 'Ringkasan Pengelolaan Sistem', konten: 'Konten Web, Kelas & Materi', email: 'Pengumuman Pengguna', akun: 'Akun Firebase', backup: 'Backup & Data Sistem' };
    panelTitle.innerText = titles[selected] || titles.dashboard;
    if (panelAction) {
        panelAction.innerText = selected === 'backup' || selected === 'dashboard' ? 'Backup Semua Data' : 'Kelola Sekarang';
        panelAction.onclick = selected === 'backup' || selected === 'dashboard' ? backupAllData : undefined;
    }
    panelContent.className = 'space-y-5';
    panelContent.innerHTML = adminPanelMarkup(selected);

    navs.forEach(link => {
        const key = link.dataset.adminPanel;
        link.className = key === selected
            ? 'admin-nav active flex items-center gap-3 px-4 py-3 rounded-xl font-bold text-sm text-slate-900 bg-rose-50 border border-rose-100'
            : 'admin-nav flex items-center gap-3 px-4 py-3 rounded-xl font-bold text-sm text-slate-600 hover:bg-slate-50 border border-transparent';
    });
}

function adminPanelMarkup(panel) {
    const input = 'w-full p-3 rounded-xl border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-rose-400';
    if (panel === 'konten') return `<div class='grid lg:grid-cols-2 gap-5'>
        <form onsubmit='adminSaveClass(event)' class='bg-slate-50 rounded-2xl border border-slate-200 p-4 space-y-3'><h4 class='font-black'>Tambah / Edit Kelas</h4><input id='adminClassName' required class='${input}' placeholder='Nama kelas'><textarea id='adminClassDescription' class='${input}' rows='2' placeholder='Deskripsi kelas'></textarea><button class='bg-slate-900 text-white font-bold px-4 py-2 rounded-xl text-xs'>Simpan Kelas</button></form>
        <form onsubmit='adminSaveMaterial(event)' class='bg-slate-50 rounded-2xl border border-slate-200 p-4 space-y-3'><h4 class='font-black'>Tambah Materi ke Kelas</h4><select id='adminMaterialClass' required class='${input}'>${state.classes.map(c => `<option value='${c.id}'>${c.nama}</option>`).join('')}</select><input id='adminMaterialTitle' required class='${input}' placeholder='Judul materi'><textarea id='adminMaterialDescription' required class='${input}' rows='2' placeholder='Deskripsi materi'></textarea><input id='adminMaterialLink' class='${input}' placeholder='Link dokumen / video (opsional)'><button class='bg-emerald-600 text-white font-bold px-4 py-2 rounded-xl text-xs'>Simpan Materi</button></form>
        <div class='lg:col-span-2 space-y-3'><h4 class='font-black'>Kelas dan Materi</h4>${state.classes.map(c => `<div class='border border-slate-200 rounded-2xl p-4'><div class='flex justify-between gap-3'><div><b>${c.nama}</b><p class='text-xs text-slate-500 mt-1'>${c.deskripsi || 'Tanpa deskripsi'}</p></div><button onclick='adminDeleteClass(${c.id})' class='text-rose-600 text-xs font-bold'>Hapus Kelas</button></div><div class='mt-3 space-y-2'>${(c.materi || []).map(m => `<div class='flex justify-between items-center bg-slate-50 rounded-xl p-3 text-sm'><span>${m.judul}</span><button onclick='adminDeleteMaterial(${c.id}, ${m.id})' class='text-rose-600 text-xs font-bold'>Hapus</button></div>`).join('') || `<p class='text-xs text-slate-500'>Belum ada materi.</p>`}</div></div>`).join('')}</div></div>`;
    if (panel === 'akun') return `<div class='space-y-4'>
        <div class='rounded-2xl border border-blue-200 bg-blue-50 p-4'><h4 class='font-black text-blue-900'>Akun dikelola oleh Firebase</h4><p class='mt-2 text-sm text-blue-800'>Panel ini tidak membuat kata sandi, token, atau akun lokal. Firebase Authentication menyimpan kredensial; Firestore menyimpan profil dan role.</p></div>
        <div class='grid gap-3 md:grid-cols-2'>
            <div class='rounded-2xl border border-slate-200 p-4'><h5 class='font-bold text-slate-900'>Siswa</h5><p class='mt-2 text-sm text-slate-600'>Siswa mendaftar dari halaman login. Akun Authentication dan dokumen <code>users/{uid}</code> ber-role <code>student</code> dibuat otomatis.</p></div>
            <div class='rounded-2xl border border-slate-200 p-4'><h5 class='font-bold text-slate-900'>Guru dan admin</h5><p class='mt-2 text-sm text-slate-600'>Buat pengguna di Authentication, lalu buat profil <code>users/{uid}</code> di Firestore dengan email yang sama dan role <code>teacher</code> atau <code>admin</code>. UID dokumen harus sama dengan UID Authentication.</p></div>
        </div>
        <div class='flex flex-wrap gap-3'><a href='https://console.firebase.google.com/project/mathlearn-b766d/authentication/users' target='_blank' rel='noopener noreferrer' class='inline-flex items-center rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white'>Buka Firebase Authentication</a><a href='https://console.firebase.google.com/project/mathlearn-b766d/firestore/databases/-default-/data' target='_blank' rel='noopener noreferrer' class='inline-flex items-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-700'>Buka Firestore</a></div>
        <div class='rounded-2xl border border-slate-200 bg-slate-50 p-4'><h5 class='text-xs font-bold uppercase text-slate-500'>Sesi admin saat ini</h5><p class='mt-2 text-sm font-bold text-slate-900'>${escapeHtml(state.currentUser?.nama || 'Admin')}</p><p class='text-xs text-slate-600'>${escapeHtml(state.currentUser?.email || '')} · ${escapeHtml(state.currentUser?.role || 'admin')}</p><p class='mt-1 break-all font-mono text-xs text-slate-500'>UID: ${escapeHtml(state.currentUser?.id || '-')}</p></div>
    </div>`;
    if (panel === 'email') return `<form onsubmit='adminSendEmail(event)' class='bg-slate-50 rounded-2xl border border-slate-200 p-4 space-y-3'><select id='adminEmailTarget' class='${input}'><option value='all'>Semua pengguna</option>${state.users.map(u => `<option value='${u.id}'>${u.nama} (${u.email})</option>`).join('')}</select><input id='adminEmailSubject' required class='${input}' placeholder='Subjek email'><textarea id='adminEmailMessage' required class='${input}' rows='4' placeholder='Isi pengumuman'></textarea><button class='bg-rose-600 text-white font-bold px-4 py-2 rounded-xl text-xs'>Catat & Kirim Broadcast</button></form><div class='space-y-2'>${state.emailLogs.slice().reverse().map(log => `<div class='border border-slate-200 rounded-xl p-3'><b class='text-sm'>${log.subject}</b><span class='block text-xs text-slate-500'>${log.target} · ${new Date(log.date).toLocaleString()}</span><p class='text-xs mt-2'>${log.message}</p></div>`).join('') || `<p class='text-xs text-slate-500'>Belum ada email tercatat.</p>`}</div>`;
    if (panel === 'backup') return `<div class='bg-slate-50 border border-slate-200 rounded-2xl p-5'><h4 class='font-black'>Backup data pembelajaran</h4><p class='text-sm text-slate-600 mt-2'>Mencakup kelas, materi, tugas, pengumuman, nilai, dan log aktivitas. Kredensial serta profil akun Firebase tidak disertakan.</p><button onclick='backupAllData()' class='mt-4 bg-emerald-600 text-white font-bold px-4 py-2 rounded-xl text-xs'>Unduh Backup JSON</button><p class='text-xs text-slate-500 mt-3'>Backup terakhir: ${localStorage.getItem('mathlearn_backup') ? 'tersedia di browser ini' : 'belum ada'}</p></div>`;
    return `<div class='grid md:grid-cols-2 gap-4'><div class='rounded-2xl border border-slate-200 bg-slate-50 p-4'><b>${state.classes.length} Kelas</b><p class='text-sm text-slate-600 mt-2'>Kelas dapat dibuat dan dihapus dari tab Konten Web.</p></div><div class='rounded-2xl border border-slate-200 bg-slate-50 p-4'><b>Akun Firebase</b><p class='text-sm text-slate-600 mt-2'>Siswa mendaftar langsung; akun guru dan admin dibuat melalui Firebase Authentication dan Firestore.</p></div><div class='rounded-2xl border border-slate-200 bg-slate-50 p-4'><b>${state.materiList.length + state.classes.reduce((n, c) => n + (c.materi || []).length, 0)} Materi</b><p class='text-sm text-slate-600 mt-2'>Gunakan tab Konten Web untuk mengelola materi per kelas.</p></div><div class='rounded-2xl border border-slate-200 bg-slate-50 p-4'><b>${state.emailLogs.length} Pengumuman</b><p class='text-sm text-slate-600 mt-2'>Gunakan tab Email Pengguna untuk mengelola catatan pengumuman.</p></div></div>`;
}

async function adminSaveClass(e) { e.preventDefault(); state.classes.unshift({ id: Date.now(), nama: document.getElementById('adminClassName').value, deskripsi: document.getElementById('adminClassDescription').value, materi: [] }); await saveLearningContent(); renderAdminView(); }
function adminDeleteClass(id) { customConfirm('Hapus kelas beserta materi di dalamnya?', async () => { state.classes = state.classes.filter(c => c.id !== id); state.materiList = state.materiList.filter(m => m.classId !== id); removeClassNotifications(id); await saveLearningContent(); renderAdminView(); }); }
async function adminSaveMaterial(e) { e.preventDefault(); const c = state.classes.find(item => item.id === Number(document.getElementById('adminMaterialClass').value)); if (!c) return; const material = { id: Date.now(), judul: document.getElementById('adminMaterialTitle').value, deskripsi: document.getElementById('adminMaterialDescription').value, link: document.getElementById('adminMaterialLink').value, classId: c.id }; c.materi = c.materi || []; c.materi.unshift(material); state.materiList.unshift({ id: material.id, judul: material.judul, deskripsi: material.deskripsi, yt: '', file: material.link, classId: c.id }); addStudentNotification('Materi', material.judul, c.id, material.id, 'Materi'); await saveLearningContent(); renderAdminView(); }
async function adminDeleteMaterial(classId, materialId) { const currentClass = state.classes.find(c => c.id === classId); if (!currentClass) return; currentClass.materi = currentClass.materi.filter(m => m.id !== materialId); state.materiList = state.materiList.filter(m => m.id !== materialId); removeContentNotification(materialId, 'Materi'); await saveLearningContent(); renderAdminView(); }
function adminSendEmail(e) { e.preventDefault(); const target = document.getElementById('adminEmailTarget'); state.emailLogs.push({ date: new Date().toISOString(), target: target.value === 'all' ? 'Semua pengguna' : state.users.find(u => u.id === Number(target.value))?.email, subject: document.getElementById('adminEmailSubject').value, message: document.getElementById('adminEmailMessage').value }); saveState(); customAlert('Broadcast tercatat untuk penerima yang dipilih.', 'Email Berhasil'); renderAdminView(); }

function switchAdminPanel(panelKey) {
    const adminMap = {
        dashboard: 'dashboard',
        konten: 'konten',
        email: 'email',
        akun: 'akun',
        backup: 'backup'
    };
    const selected = adminMap[panelKey] || 'dashboard';
    if (window.location.hash !== `#${selected}`) window.location.hash = selected;
    renderAdminView();
}

function switchStudentTab(tabName) {
    state.activeTab = tabName;
    if (window.location.hash !== `#${tabName}`) window.location.hash = tabName;
    document.querySelectorAll('.tab-siswa-btn').forEach(btn => {
        let defaultClass = "tab-siswa-btn px-5 py-2.5 rounded-xl text-xs font-bold transition bg-white border shadow-sm ";
        if (btn.id === 'tabSiswaHasil') defaultClass += "text-emerald-600 border-emerald-200 hover:bg-emerald-50";
        else defaultClass += "text-slate-600 border-slate-200 hover:bg-slate-50";
        btn.className = defaultClass;
    });
    document.querySelectorAll('.sub-siswa-panel').forEach(p => p.classList.add('hidden'));

    const activeBtn = document.getElementById(`tabSiswa${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
    if (activeBtn) {
        if (tabName === 'hasil') activeBtn.className = "tab-siswa-btn active px-5 py-2.5 rounded-xl text-xs font-bold transition bg-emerald-600 text-white shadow-md flex items-center gap-1";
        else activeBtn.className = "tab-siswa-btn active px-5 py-2.5 rounded-xl text-xs font-bold transition bg-blue-600 text-white shadow-md";
    }

    const activePanel = document.getElementById(`subSiswa${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
    if (activePanel) {
        activePanel.classList.remove('hidden');
        if (['lkpd', 'latihan', 'evaluasi'].includes(tabName)) {
            const cType = tabName.charAt(0).toUpperCase() + tabName.slice(1);
            closeStudentTask(cType);
        }
    }
}

function isTaskOpen(openDate, closeDate) {
    const now = new Date();
    const start = new Date(openDate);
    const end = new Date(closeDate);
    return now >= start && now <= end;
}

function openStudentTask(type, id) {
    const task = state.taskList[type].find(t => t.id === id);
    if (!task) return;

    if (!isTaskOpen(task.openDate, task.closeDate)) {
        customAlert(`Tugas ini belum dapat diakses atau sudah ditutup.\nJadwal: ${new Date(task.openDate).toLocaleString()} - ${new Date(task.closeDate).toLocaleString()}`, "Akses Ditolak");
        return;
    }

    document.getElementById(`siswa${type}ListView`)?.classList.add('hidden');
    document.getElementById(`siswa${type}DetailView`)?.classList.remove('hidden');

    const titleEl = document.getElementById(`siswa${type}Title`);
    const idEl = document.getElementById(`siswa${type}ActiveId`);

    if (titleEl) titleEl.innerText = task.title;
    if (idEl) idEl.value = task.id;
    activeStudentQuestion[type] = { taskId: id, index: 0, cheatCount: 0, answers: task.questions.map(() => ({ answer: '', fileName: '', file: null })) };
    startStudentTaskTimer(type, task);
    renderStudentQuestion(type, task);
}

function startStudentTaskTimer(type, task) {
    clearInterval(studentTaskTimers[type]);
    const timerEl = document.getElementById(`siswa${type}Timer`);
    const updateTimer = () => {
        const remaining = new Date(task.closeDate).getTime() - Date.now();
        if (remaining <= 0) {
            if (timerEl) timerEl.innerText = '00:00:00';
            clearInterval(studentTaskTimers[type]);
            customAlert('Waktu pengerjaan sudah habis. Jawaban tidak dapat dikirim lagi.', 'Waktu Habis');
            closeStudentTask(type);
            return;
        }
        const totalSeconds = Math.floor(remaining / 1000);
        const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
        const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
        const seconds = String(totalSeconds % 60).padStart(2, '0');
        if (timerEl) {
            timerEl.innerText = `${hours}:${minutes}:${seconds}`;
            timerEl.classList.toggle('text-rose-600', totalSeconds <= 300);
        }
    };
    updateTimer();
    studentTaskTimers[type] = setInterval(updateTimer, 1000);
}

function renderStudentQuestion(type, task) {
    const session = activeStudentQuestion[type];
    if (!session || !task) return;
    const question = normalizeQuestion(task.questions[session.index]);
    const draft = session.answers[session.index] || { answer: '', fileName: '', file: null };
    const boxEl = document.getElementById(`siswa${type}QuestionBox`);
    const answerEl = document.getElementById(`siswa${type}Jawaban`);
    const fileEl = document.getElementById(`file${type}Upload`);
    const progressEl = document.getElementById(`siswa${type}QuestionProgress`);
    const labelEl = document.getElementById(`siswa${type}AnswerLabel`);
    const previousButton = document.getElementById(`siswa${type}PreviousQuestionButton`);

    if (boxEl) {
        boxEl.innerHTML = `${question.text ? `<p>${escapeHtml(question.text)}</p>` : ''}${question.image ? `<img src="${question.image}" alt="Foto soal" class="max-h-80 max-w-full rounded-xl border border-slate-200 mt-3 object-contain">` : ''}${question.type === 'choice' ? `<p class="text-xs font-bold text-slate-500 mt-3">Pilih satu jawaban:</p>` : ''}`;
    }
    if (answerEl) answerEl.value = draft.answer;
    const answerParent = answerEl?.parentElement;
    const oldChoice = document.getElementById(`siswa${type}Choice`);
    if (oldChoice) oldChoice.remove();
    if (answerEl) answerEl.classList.toggle('hidden', question.type === 'choice');
    if (question.type === 'choice' && answerParent) {
        const choice = document.createElement('select');
        choice.id = `siswa${type}Choice`;
        choice.dataset.studentChoice = 'true';
        choice.className = 'w-full p-4 rounded-xl border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-blue-500';
        choice.innerHTML = `<option value="">Pilih jawaban</option>${(question.options || []).map((option, index) => `<option value="${index}">${String.fromCharCode(65 + index)}. ${escapeHtml(option)}</option>`).join('')}`;
        choice.value = draft.answer;
        answerParent.appendChild(choice);
    }
    if (fileEl) fileEl.value = '';
    if (progressEl) progressEl.innerText = `Soal ${session.index + 1} dari ${task.questions.length}`;
    if (labelEl) labelEl.innerText = `Jawaban Soal ${session.index + 1}:`;
    if (previousButton) previousButton.disabled = session.index === 0;
}

function saveCurrentStudentQuestion(type) {
    const session = activeStudentQuestion[type];
    if (!session) return;
    const answerEl = document.getElementById(`siswa${type}Jawaban`);
    const fileEl = document.getElementById(`file${type}Upload`);
    const choiceEl = document.getElementById(`siswa${type}Choice`);
    session.answers[session.index] = {
        answer: choiceEl ? choiceEl.value : answerEl?.value.trim() || '',
        fileName: fileEl?.files[0]?.name || session.answers[session.index]?.fileName || '',
        file: fileEl?.files[0] || session.answers[session.index]?.file || null
    };
}

function previousStudentQuestion(type) {
    const session = activeStudentQuestion[type];
    const task = session && state.taskList[type].find(item => item.id === session.taskId);
    if (!session || !task || session.index === 0) return;
    saveCurrentStudentQuestion(type);
    session.index -= 1;
    renderStudentQuestion(type, task);
}

function nextStudentQuestion(type) {
    const session = activeStudentQuestion[type];
    const task = session && state.taskList[type].find(item => item.id === session.taskId);
    if (!session || !task) return;
    saveCurrentStudentQuestion(type);
    if (!session.answers[session.index].answer && !session.answers[session.index].fileName) {
        customAlert('Isi jawaban atau unggah file sebelum melanjutkan.');
        return;
    }
    if (session.index < task.questions.length - 1) {
        session.index += 1;
        renderStudentQuestion(type, task);
        return;
    }
    customAlert('Ini adalah soal terakhir. Periksa jawaban, lalu kirimkan tugas.');
}

async function openStudentCamera(type) {
    if (!activeStudentQuestion[type]) return;
    const modal = document.getElementById('studentCameraModal');
    const video = document.getElementById('studentCameraVideo');
    const message = document.getElementById('studentCameraMessage');
    if (!modal || !video || !message) return;

    closeStudentCamera();
    studentCameraType = type;
    message.innerText = '';
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        message.innerText = 'Kamera web memerlukan koneksi aman HTTPS atau localhost. Buka situs melalui alamat HTTPS.';
        return;
    }

    try {
        try {
            studentCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        } catch (error) {
            studentCameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        video.srcObject = studentCameraStream;
        await video.play();
    } catch (error) {
        closeStudentCamera();
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        message.innerText = error.name === 'NotAllowedError'
            ? 'Izin kamera ditolak. Izinkan akses kamera melalui pengaturan izin situs di browser.'
            : error.name === 'NotFoundError'
                ? 'Kamera tidak ditemukan pada perangkat ini.'
                : error.name === 'NotReadableError'
                    ? 'Kamera sedang digunakan aplikasi lain. Tutup aplikasi tersebut lalu coba lagi.'
                    : 'Kamera gagal dibuka. Periksa izin kamera dan pastikan kamera tidak sedang digunakan aplikasi lain.';
    }
}

async function captureStudentCamera() {
    const video = document.getElementById('studentCameraVideo');
    const message = document.getElementById('studentCameraMessage');
    const type = studentCameraType;
    if (!video || !studentCameraStream || !type || !video.videoWidth || !video.videoHeight) {
        if (message) message.innerText = 'Tunggu sampai pratinjau kamera tampil, lalu ambil foto.';
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) {
        if (message) message.innerText = 'Foto gagal diproses. Coba ambil foto sekali lagi.';
        return;
    }

    const file = new File([blob], `foto-${type.toLowerCase()}-${Date.now()}.jpg`, { type: 'image/jpeg' });
    const fileInput = document.getElementById(`file${type}Upload`);
    const session = activeStudentQuestion[type];
    if (!session) {
        closeStudentCamera();
        return;
    }
    session.answers[session.index] = { ...session.answers[session.index], fileName: file.name, file };
    if (fileInput) {
        try {
            const transfer = new DataTransfer();
            transfer.items.add(file);
            fileInput.files = transfer.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        } catch {}
    }
    closeStudentCamera();
}

function closeStudentCamera() {
    if (studentCameraStream) studentCameraStream.getTracks().forEach(track => track.stop());
    studentCameraStream = null;
    studentCameraType = null;
    const video = document.getElementById('studentCameraVideo');
    if (video) video.srcObject = null;
    const modal = document.getElementById('studentCameraModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

async function openTeacherQuestionCamera(type, input) {
    const modal = document.getElementById('teacherCameraModal');
    const video = document.getElementById('teacherCameraVideo');
    const message = document.getElementById('teacherCameraMessage');
    if (!modal || !video || !message || !input) return;

    closeTeacherQuestionCamera();
    teacherQuestionCameraInput = input;
    message.innerText = '';
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        message.innerText = 'Kamera web memerlukan koneksi aman HTTPS atau localhost. Buka situs melalui alamat HTTPS.';
        return;
    }

    try {
        try {
            teacherQuestionCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        } catch (error) {
            teacherQuestionCameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        video.srcObject = teacherQuestionCameraStream;
        await video.play();
    } catch (error) {
        closeTeacherQuestionCamera();
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        message.innerText = error.name === 'NotAllowedError'
            ? 'Izin kamera ditolak. Izinkan akses kamera melalui pengaturan izin situs di browser.'
            : error.name === 'NotFoundError'
                ? 'Kamera tidak ditemukan pada perangkat ini.'
                : error.name === 'NotReadableError'
                    ? 'Kamera sedang digunakan aplikasi lain. Tutup aplikasi tersebut lalu coba lagi.'
                    : 'Kamera gagal dibuka. Periksa izin kamera dan pastikan kamera tidak sedang digunakan aplikasi lain.';
    }
}

async function captureTeacherQuestionCamera() {
    const video = document.getElementById('teacherCameraVideo');
    const message = document.getElementById('teacherCameraMessage');
    if (!video || !teacherQuestionCameraStream || !teacherQuestionCameraInput || !video.videoWidth || !video.videoHeight) {
        if (message) message.innerText = 'Tunggu sampai pratinjau kamera tampil, lalu ambil foto.';
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) {
        if (message) message.innerText = 'Foto gagal diproses. Coba ambil foto sekali lagi.';
        return;
    }

    try {
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], `foto-soal-${Date.now()}.jpg`, { type: 'image/jpeg' }));
        teacherQuestionCameraInput.files = transfer.files;
        teacherQuestionCameraInput.dispatchEvent(new Event('change', { bubbles: true }));
        closeTeacherQuestionCamera();
    } catch (error) {
        if (message) message.innerText = 'Browser tidak mendukung pemasangan foto otomatis. Gunakan pemilih file pada form soal.';
    }
}

function closeTeacherQuestionCamera() {
    if (teacherQuestionCameraStream) teacherQuestionCameraStream.getTracks().forEach(track => track.stop());
    teacherQuestionCameraStream = null;
    teacherQuestionCameraInput = null;
    const video = document.getElementById('teacherCameraVideo');
    if (video) video.srcObject = null;
    const modal = document.getElementById('teacherCameraModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

function closeStudentTask(type) {
    const list = document.getElementById(`siswa${type}ListView`);
    const detail = document.getElementById(`siswa${type}DetailView`);
    if (list && detail) {
        list.classList.remove('hidden');
        detail.classList.add('hidden');
    }
    delete activeStudentQuestion[type];
    clearInterval(studentTaskTimers[type]);
    delete studentTaskTimers[type];
}

function renderSiswaView() {
    const currentStudent = getCurrentStudentUser();
    const classSelector = document.getElementById('studentClassSelector');
    if (classSelector) {
        classSelector.innerHTML = `<option value="">Pilih kelas</option>${state.classes.map(item => `<option value="${item.id}">${escapeHtml(item.nama)}</option>`).join('')}`;
        classSelector.value = currentStudent?.classId || state.currentUser?.classId || '';
    }
    const selectedClassId = Number(currentStudent?.classId || state.currentUser?.classId || 0);
    const isForSelectedClass = item => !item.classId || (selectedClassId > 0 && Number(item.classId) === selectedClassId);
    const notificationContainer = document.getElementById('studentNotificationList');
    if (notificationContainer) {
        const dismissedIds = getDismissedStudentNotificationIds();
        const visibleNotifications = state.notifications.filter(notification => isForSelectedClass(notification) && !dismissedIds.has(String(notification.id)));
        const totalPages = Math.ceil(visibleNotifications.length / studentNotificationPageSize);
        studentNotificationPage = Math.min(studentNotificationPage, Math.max(0, totalPages - 1));
        const pageStart = studentNotificationPage * studentNotificationPageSize;
        document.getElementById('studentNotificationDot')?.classList.toggle('hidden', visibleNotifications.length === 0);
        notificationContainer.innerHTML = visibleNotifications.slice(pageStart, pageStart + studentNotificationPageSize).map(notification => `
            <button type="button" onclick="markStudentNotificationRead(${notification.id})" class="w-full text-left flex items-start gap-3 bg-blue-50 border border-blue-100 rounded-xl p-3 hover:bg-blue-100 transition" title="Buka update">
                <span class="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center text-xs font-black">${notification.type === 'Materi' ? 'M' : 'S'}</span>
                <div><p class="text-sm font-bold text-slate-800">${escapeHtml(notification.type)} baru tersedia</p><p class="text-xs text-slate-600 mt-1">${escapeHtml(notification.title)} · ${escapeHtml(getClassName(notification.classId))}</p><p class="text-[10px] text-slate-500 mt-1">${new Date(notification.date).toLocaleString()}</p></div>
            </button>
        `).join('');
        if (!visibleNotifications.length) notificationContainer.innerHTML = '<p class="text-sm text-slate-500">Belum ada materi atau soal baru.</p>';
        const pagination = document.getElementById('studentNotificationPagination');
        if (pagination) {
            pagination.innerHTML = totalPages > 1 ? `
                <button type="button" onclick="changeStudentNotificationPage(-1)" ${studentNotificationPage === 0 ? 'disabled' : ''} class="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">← Sebelumnya</button>
                <span class="text-xs font-semibold text-slate-500">Halaman ${studentNotificationPage + 1} dari ${totalPages}</span>
                <button type="button" onclick="changeStudentNotificationPage(1)" ${studentNotificationPage >= totalPages - 1 ? 'disabled' : ''} class="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">Berikutnya →</button>
            ` : '';
        }
    }
    // Render Materials
    const materiContainer = document.getElementById('siswaMateriContainer');
    if (materiContainer) {
        const visibleMaterials = state.materiList.filter(isForSelectedClass);
        materiContainer.innerHTML = visibleMaterials.map(m => `
            <div class="bg-slate-50 p-5 rounded-2xl border border-slate-200 flex flex-col justify-between">
                <div>
                    <h4 class="font-extrabold text-sm text-slate-900 mb-1">${m.judul}</h4>
                    <p class="text-xs text-slate-600 leading-relaxed mb-4">${m.deskripsi}</p>
                </div>
                <div class="flex items-center gap-2 pt-2 border-t border-slate-200">
                    ${m.yt ? `<a href="${m.yt}" target="_blank" class="text-[11px] bg-red-100 text-red-700 font-bold px-3 py-1.5 rounded-lg hover:bg-red-200 transition">▶ Youtube</a>` : ''}
                    ${m.file ? `<a href="${escapeHtml(m.file)}" ${m.file.startsWith('data:') ? `download="${escapeHtml(m.fileName || 'materi')}"` : 'target="_blank" rel="noopener noreferrer"'} class="text-[11px] bg-blue-100 text-blue-700 font-bold px-3 py-1.5 rounded-lg hover:bg-blue-200 transition">${m.fileName ? 'Unduh File Materi' : '📄 Dokumen'}</a>` : ''}
                </div>
            </div>
        `).join('');
        if (visibleMaterials.length === 0) materiContainer.innerHTML = `<p class="text-sm text-slate-500">Belum ada materi untuk kelas ini.</p>`;
    }

    // Helper to render task lists
    const renderTaskList = (type) => {
        const container = document.getElementById(`siswa${type}ListContainer`);
        if (!container) return;
        const visibleTasks = state.taskList[type].filter(isForSelectedClass);
        container.innerHTML = visibleTasks.map(t => {
            const isOpen = isTaskOpen(t.openDate, t.closeDate);
            return `
            <div class="flex items-center justify-between bg-white p-4 rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition">
                <div>
                    <h4 class="font-bold text-sm text-slate-800">${t.title}</h4>
                    <p class="text-[10px] text-slate-500 mt-0.5">Berlaku: ${new Date(t.openDate).toLocaleString()} - ${new Date(t.closeDate).toLocaleString()}</p>
                </div>
                <button onclick="openStudentTask('${type}', ${t.id})" class="px-4 py-2 text-xs font-bold rounded-lg transition ${isOpen ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-slate-200 text-slate-500 cursor-not-allowed'}">
                    ${isOpen ? 'Kerjakan' : 'Terkunci'}
                </button>
            </div>`;
        }).join('');
        if (visibleTasks.length === 0) container.innerHTML = '<p class="text-xs text-slate-500">Belum ada daftar tugas untuk kelas ini.</p>';
    };

    renderTaskList('Lkpd');
    renderTaskList('Latihan');
    renderTaskList('Evaluasi');

    // Render Hasil Tab
    const hasilContainer = document.getElementById('siswaHasilContainer');
    if (hasilContainer && state.currentUser) {
        const myResults = state.studentSubmissions.filter(s => s.nama === state.currentUser.nama && s.status === 'reviewed');
        hasilContainer.innerHTML = myResults.map(s => `
            <div class="bg-emerald-50/30 rounded-xl p-5 border border-emerald-200">
                <div class="flex justify-between items-start mb-3">
                    <div>
                        <span class="text-[10px] font-black uppercase bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">${s.taskType}</span>
                        <h4 class="font-extrabold text-sm text-slate-900 mt-1">${s.taskTitle}</h4>
                        <p class="text-[10px] text-slate-500">Dikumpulkan: ${s.timestamp}</p>
                    </div>
                    <div class="text-right">
                        <span class="text-2xl font-black text-emerald-600">${s.finalScore || s.aiScore}</span>
                        <span class="block text-[9px] font-bold text-slate-500">NILAI AKHIR</span>
                    </div>
                </div>
                <div class="bg-white p-3 rounded-lg border border-slate-200 mb-3 text-xs">
                    <p class="font-bold text-slate-700 mb-1">Jawaban Kamu:</p>
                    <p class="text-slate-600 line-clamp-2">${s.jawaban}</p>
                </div>
                <div class="bg-indigo-50 border border-indigo-100 p-3 rounded-lg text-xs">
                    <p class="font-bold text-indigo-900 mb-1">Catatan & Feedback Guru:</p>
                    <p class="text-indigo-800">${s.teacherNote || 'Guru tidak meninggalkan catatan spesifik. Kerja bagus!'}</p>
                </div>
            </div>
        `).join('');
        if (myResults.length === 0) hasilContainer.innerHTML = '<p class="text-xs text-slate-500 text-center py-8">Belum ada tugas yang dinilai dan dipublikasikan oleh guru.</p>';
    }

    const cheatBadge = document.getElementById('studentCheatStatus');
    if (cheatBadge) cheatBadge.innerText = state.studentCheatLogs.length;
}

function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function insertEquationSymbol(inputId, symbol) {
    const input = document.getElementById(inputId);
    if (!input || input.disabled || input.classList.contains('hidden')) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = `${input.value.slice(0, start)}${symbol}${input.value.slice(end)}`;
    input.focus();
    const cursor = start + symbol.length;
    input.setSelectionRange(cursor, cursor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function showEquationKeyboard(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const existing = document.getElementById(`${inputId}EquationKeyboard`);
    if (existing) {
        existing.classList.toggle('hidden');
        return;
    }
    const keyboard = document.createElement('div');
    keyboard.id = `${inputId}EquationKeyboard`;
    keyboard.className = 'mt-2 flex flex-wrap gap-1.5';
    keyboard.setAttribute('aria-label', 'Keyboard persamaan');
    ['²', '³', '√', 'π', '±', '÷', '×', '≤', '≥', '≠', '°', '→', '½', '¼'].forEach(symbol => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'equation-key px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200';
        button.innerText = symbol;
        button.onclick = () => insertEquationSymbol(inputId, symbol);
        keyboard.appendChild(button);
    });
    input.parentElement.appendChild(keyboard);
}

function normalizeQuestion(question) {
    if (typeof question === 'string') return { type: 'text', text: question, image: '', options: [], correctAnswer: '' };
    return { type: 'text', text: '', image: '', options: [], correctAnswer: '', ...question };
}

function switchTeacherTab(tabName) {
    state.activeTab = tabName;
    if (window.location.hash !== `#${tabName}`) window.location.hash = tabName;
    document.querySelectorAll('.tab-guru-btn').forEach(btn => {
        btn.className = "tab-guru-btn px-4 py-2.5 rounded-xl text-xs font-bold transition bg-white text-slate-600 border border-slate-200 hover:bg-slate-50";
    });
    document.querySelectorAll('.sub-guru-panel').forEach(p => p.classList.add('hidden'));

    const activeBtn = document.getElementById(`tabGuru${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
    if (activeBtn) {
        if (tabName === 'review') activeBtn.className = "tab-guru-btn active px-4 py-2.5 rounded-xl text-xs font-bold transition bg-emerald-600 text-white shadow-md";
        else activeBtn.className = "tab-guru-btn active px-4 py-2.5 rounded-xl text-xs font-bold transition bg-indigo-600 text-white shadow-md";
    }

    const activePanel = document.getElementById(`subGuru${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
    if (activePanel) activePanel.classList.remove('hidden');
}

function getClassName(classId) {
    return state.classes.find(item => item.id === Number(classId))?.nama || 'Belum dipilih';
}

function getCurrentStudentUser() {
    return state.users.find(user => user.id === state.currentUser?.id || user.email === state.currentUser?.email);
}

async function selectStudentClass(classId) {
    const student = getCurrentStudentUser();
    const selectedClass = state.classes.find(item => Number(item.id) === Number(classId));
    if (normalizeRole(state.currentUser?.role) !== 'student' || !selectedClass) return;
    if (student) student.classId = Number(selectedClass.id);
    state.currentUser.classId = Number(selectedClass.id);
    saveState();
    renderSiswaView();
    if (isFirebaseReady() && firebaseAuth.currentUser?.uid === state.currentUser.id) {
        try {
            await firebaseDb.collection('users').doc(state.currentUser.id).update({ classId: state.currentUser.classId });
        } catch (error) {
            console.error('Gagal menyimpan kelas siswa ke Firestore:', error);
            customAlert('Kelas dipilih pada perangkat ini, tetapi gagal disimpan ke akun. Periksa koneksi lalu pilih kelas kembali.', 'Gagal Menyimpan Kelas');
        }
    }
}
function adminSaveMaterial(e) { e.preventDefault(); const c = state.classes.find(item => item.id === Number(document.getElementById('adminMaterialClass').value)); if (!c) return; const material = { id: Date.now(), judul: document.getElementById('adminMaterialTitle').value, deskripsi: document.getElementById('adminMaterialDescription').value, link: document.getElementById('adminMaterialLink').value, classId: c.id }; c.materi = c.materi || []; c.materi.unshift(material); state.materiList.unshift({ id: material.id, judul: material.judul, deskripsi: material.deskripsi, yt: '', file: material.link, classId: c.id }); addStudentNotification('Materi', material.judul, c.id, material.id, 'Materi'); saveState(); renderAdminView(); }
function adminSendEmail(e) { e.preventDefault(); const target = document.getElementById('adminEmailTarget'); const subject = document.getElementById('adminEmailSubject').value; const message = document.getElementById('adminEmailMessage').value; state.emailLogs.push({ date: new Date().toISOString(), target: target.value === 'all' ? 'Semua pengguna' : state.users.find(u => u.id === Number(target.value))?.email, subject, message }); addStudentNotification('Pengumuman', subject, null); saveState(); customAlert('Broadcast tercatat untuk penerima yang dipilih.', 'Email Berhasil'); renderAdminView(); }

function getTaskReviewMarkup(submission) {
    const task = (state.taskList[submission.taskType] || []).find(item => Number(item.id) === Number(submission.taskId));
    if (!task || !Array.isArray(task.questions) || task.questions.length === 0) return '';

    const questions = task.questions.map((rawQuestion, index) => {
        const question = normalizeQuestion(rawQuestion);
        const options = question.type === 'choice'
            ? `<ol class="mt-2 list-inside list-[upper-alpha] space-y-1 text-slate-700">${(question.options || []).map((option, optionIndex) => `<li>${escapeHtml(option)}${String(question.correctAnswer) === String(optionIndex) ? ' <strong class="text-emerald-700">(Kunci)</strong>' : ''}</li>`).join('')}</ol>`
            : '';
        return `<div class="rounded-xl border border-slate-200 bg-white p-3"><p class="text-[10px] font-black uppercase text-slate-500">Soal ${index + 1}</p>${question.text ? `<p class="mt-1 whitespace-pre-wrap text-sm text-slate-800">${escapeHtml(question.text)}</p>` : ''}${question.image ? `<img src="${escapeHtml(question.image)}" alt="Foto soal ${index + 1}" class="mt-3 max-h-72 max-w-full rounded-lg border border-slate-200 object-contain">` : ''}${options}</div>`;
    }).join('');

    return `<div class="space-y-2 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4"><p class="text-xs font-black text-indigo-900">Soal dan pilihan</p>${questions}</div>`;
}

function getSubmissionAttachmentsMarkup(submission) {
    const attachments = Array.isArray(submission.attachments) ? submission.attachments : [];
    if (!attachments.length) return submission.fileName ? `<p class="text-xs text-slate-500">Lampiran lama: ${escapeHtml(submission.fileName)} (file tidak tersimpan di server)</p>` : '';

    return attachments.map(attachment => {
        const url = escapeHtml(attachment.url || '');
        const name = escapeHtml(attachment.fileName || 'Lampiran siswa');
        const label = `Soal ${Number(attachment.questionIndex) + 1}: ${name}`;
        return attachment.contentType?.startsWith('image/')
            ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="inline-block"><img src="${url}" alt="${label}" class="max-h-80 max-w-full rounded-lg border border-slate-200 object-contain"><span class="mt-1 block text-xs text-blue-700">${label}</span></a>`
            : `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-xs font-semibold text-blue-700 underline">${label} (Buka / unduh)</a>`;
    }).join('<br>');
}

function renderGuruView() {
    const classOptions = state.classes.length
        ? state.classes.map(c => `<option value="${c.id}">${c.nama}</option>`).join('')
        : '<option value="">Buat kelas terlebih dahulu</option>';
    ['guruMateriClass', 'formLkpdClass', 'formLatihanClass', 'formEvaluasiClass'].forEach(id => {
        const selector = document.getElementById(id);
        if (selector && !selector.dataset.userSelected) selector.innerHTML = classOptions;
        if (selector) selector.disabled = state.classes.length === 0;
    });
    const classCount = document.getElementById('guruClassCount');
    const classList = document.getElementById('guruClassList');
    if (classCount) classCount.innerText = state.classes.length;
    if (classList) {
        classList.innerHTML = state.classes.map(c => `
            <div class="flex items-center justify-between gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200">
                <div><h4 class="font-bold text-sm text-slate-800">${c.nama}</h4><p class="text-[10px] text-slate-500 mt-1">${c.deskripsi || 'Tanpa deskripsi'}</p></div>
                <div class="flex gap-2"><button onclick="editClassByGuru(${c.id})" class="text-[11px] bg-indigo-100 hover:bg-indigo-200 text-indigo-700 font-bold px-3 py-1.5 rounded-lg transition">Edit</button><button onclick="deleteClassByGuru(${c.id})" class="text-[11px] bg-rose-100 hover:bg-rose-200 text-rose-700 font-bold px-3 py-1.5 rounded-lg transition">Hapus</button></div>
            </div>
        `).join('');
        if (state.classes.length === 0) classList.innerHTML = '<p class="text-xs text-slate-500">Belum ada kelas aktif.</p>';
    }

    // Render Materials
    const matContainer = document.getElementById('guruMateriListContainer');
    if (matContainer) {
        matContainer.innerHTML = state.materiList.map(m => `
            <div class="flex items-center justify-between bg-slate-50 p-4 rounded-xl border border-slate-200">
                <div>
                    <h4 class="font-bold text-sm text-slate-800">${m.judul}</h4>
                    <p class="text-[10px] text-indigo-600 font-bold mt-0.5">Kelas: ${getClassName(m.classId)}</p>
                    <p class="text-[10px] text-slate-500 mt-0.5">${m.deskripsi.substring(0, 60)}...</p>
                    ${m.file ? `<a href="${escapeHtml(m.file)}" ${m.file.startsWith('data:') ? `download="${escapeHtml(m.fileName || 'materi')}"` : 'target="_blank" rel="noopener noreferrer"'} class="inline-block mt-2 text-[10px] font-bold text-blue-700 hover:underline">${m.fileName ? `File: ${escapeHtml(m.fileName)}` : 'Buka Dokumen'}</a>` : ''}
                </div>
                    <div class="flex gap-2">
                        <button onclick="editMateri(${m.id})" class="text-[11px] bg-blue-100 hover:bg-blue-200 text-blue-700 font-bold px-3 py-1.5 rounded-lg transition">Edit</button>
                        <button onclick="deleteMateri(${m.id})" class="text-[11px] bg-rose-100 hover:bg-rose-200 text-rose-700 font-bold px-3 py-1.5 rounded-lg transition">Hapus</button>
                    </div>
            </div>
        `).join('');
        if (state.materiList.length === 0) matContainer.innerHTML = '<p class="text-xs text-slate-500">Belum ada materi aktif.</p>';
    }

    // Render Task Lists in Guru View
    ['Lkpd', 'Latihan', 'Evaluasi'].forEach(type => {
        const container = document.getElementById(`guru${type}ListContainer`);
        if (container) {
            container.innerHTML = state.taskList[type].map(t => `
                <div class="flex items-center justify-between bg-slate-50 p-4 rounded-xl border border-slate-200">
                    <div>
                        <h4 class="font-bold text-sm text-slate-800">${t.title}</h4>
                        <p class="text-[10px] text-indigo-600 font-bold">Kelas: ${getClassName(t.classId)}</p>
                        <p class="text-[10px] text-slate-500">Jadwal: ${new Date(t.openDate).toLocaleString()} - ${new Date(t.closeDate).toLocaleString()}</p>
                    </div>
                    <div class="flex gap-2">
                        <button onclick="editTask('${type}', ${t.id})" class="text-[11px] bg-blue-100 hover:bg-blue-200 text-blue-700 font-bold px-3 py-1.5 rounded-lg transition">Edit</button>
                        <button onclick="deleteTask('${type}', ${t.id})" class="text-[11px] bg-rose-100 hover:bg-rose-200 text-rose-700 font-bold px-3 py-1.5 rounded-lg transition">Hapus</button>
                    </div>
                </div>
            `).join('');
            if (state.taskList[type].length === 0) container.innerHTML = '<p class="text-xs text-slate-500">Belum ada data dibuat.</p>';
        }
    });

    // Render Review Panel
    const reviewContainer = document.getElementById('teacherReviewContainer');
    const classFilter = document.getElementById('reviewClassFilter');
    const typeFilter = document.getElementById('reviewTypeFilter');
    const taskFilter = document.getElementById('reviewTaskFilter');
    const selectedClass = classFilter?.value || 'all';
    const selectedType = typeFilter?.value || 'all';
    let selectedTask = taskFilter?.value || 'all';
    if (classFilter) {
        const previousValue = classFilter.value;
        classFilter.innerHTML = `<option value="all">Semua Kelas</option>${state.classes.map(item => `<option value="${item.id}">${escapeHtml(item.nama)}</option>`).join('')}`;
        classFilter.value = state.classes.some(item => String(item.id) === previousValue) ? previousValue : 'all';
    }
    if (taskFilter) {
        const previousValue = taskFilter.value;
        const taskChoices = [...new Map(state.studentSubmissions
            .filter(item => (selectedClass === 'all' || String(item.classId || '') === selectedClass) && (selectedType === 'all' || item.taskType === selectedType))
            .map(item => [`${item.taskType || ''}|${item.taskTitle || ''}`, item]).filter(([key]) => key !== '|')).values()];
        taskFilter.innerHTML = `<option value="all">Semua Pertemuan / Materi</option>${taskChoices.map(item => `<option value="${escapeHtml(`${item.taskType}|${item.taskTitle}`)}">${escapeHtml(`${item.taskType} - ${item.taskTitle}`)}</option>`).join('')}`;
        taskFilter.value = taskChoices.some(item => `${item.taskType}|${item.taskTitle}` === previousValue) ? previousValue : 'all';
        selectedTask = taskFilter.value;
    }
    const matchesReviewFilter = submission => (selectedClass === 'all' || String(submission.classId || '') === selectedClass) && (selectedType === 'all' || submission.taskType === selectedType) && (selectedTask === 'all' || `${submission.taskType}|${submission.taskTitle}` === selectedTask);
    const filteredSubmissions = state.studentSubmissions.filter(matchesReviewFilter);
    const sortReviewGroups = submissions => submissions.slice().sort((left, right) => {
        const leftKey = `${left.classId || 0}-${left.taskType || ''}-${left.taskTitle || ''}`;
        const rightKey = `${right.classId || 0}-${right.taskType || ''}-${right.taskTitle || ''}`;
        return leftKey.localeCompare(rightKey) || String(left.nama || '').localeCompare(String(right.nama || ''));
    });
    const pendingSubmissions = sortReviewGroups(filteredSubmissions.filter(s => s.status === 'pending'));
    const reviewedSubmissions = sortReviewGroups(filteredSubmissions.filter(s => s.status === 'reviewed'));
    
    const countEl = document.getElementById('teacherReviewCount');
    if (countEl) countEl.innerText = pendingSubmissions.length;

    if (reviewContainer) {
        const groupHeader = (sub) => `<div class="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-3"><p class="text-[10px] font-black uppercase text-indigo-700">${escapeHtml(getClassName(sub.classId))} · ${escapeHtml(sub.taskType || 'Tugas')}</p><p class="text-sm font-extrabold text-slate-900 mt-1">${escapeHtml(sub.taskTitle || 'Tanpa judul')}</p></div>`;
        const pendingMarkup = pendingSubmissions.map((sub, index) => `
            ${index === 0 || `${pendingSubmissions[index - 1].classId}-${pendingSubmissions[index - 1].taskType}-${pendingSubmissions[index - 1].taskTitle}` !== `${sub.classId}-${sub.taskType}-${sub.taskTitle}` ? groupHeader(sub) : ''}
            <div class="bg-slate-50 rounded-2xl p-6 border border-slate-200 space-y-4">
                <div class="flex justify-between items-start">
                    <div>
                        <span class="bg-indigo-100 text-indigo-800 text-[10px] font-bold px-2.5 py-1 rounded-md uppercase">${sub.taskType} - ${sub.taskTitle}</span>
                        <h4 class="text-base font-extrabold text-slate-900 mt-2">${sub.nama}</h4>
                        <p class="text-[10px] text-slate-500 mt-1">Waktu: ${sub.timestamp}</p>
                    </div>
                    <div class="text-right">
                        <span class="text-[10px] text-slate-400 block font-bold mb-1">Skor AI: <span class="text-blue-600">${sub.aiScore}</span></span>
                        <input type="number" id="finalScore_${sub.id}" value="${sub.aiScore !== '...' ? sub.aiScore : ''}" class="text-2xl font-black w-24 text-right bg-white border-2 border-indigo-200 rounded-lg focus:border-indigo-600 focus:ring-2 focus:ring-indigo-100 outline-none px-2 py-1 text-indigo-700 transition" placeholder="0">
                        <span class="text-[10px] text-indigo-500 block font-bold mt-1">Nilai Akhir (Bisa Diedit)</span>
                    </div>
                </div>

                ${getTaskReviewMarkup(sub)}

                <div class="bg-white p-4 rounded-xl border border-slate-200 text-xs space-y-2">
                    <p class="font-bold text-slate-700">Jawaban Siswa:</p>
                    <p class="text-slate-600 font-mono whitespace-pre-wrap">${escapeHtml(sub.jawaban || '-')}</p>
                    ${getSubmissionAttachmentsMarkup(sub)}
                </div>

                ${sub.cheatCount > 0 || sub.taskType === 'Evaluasi' ? `
                <div class="${sub.cheatCount > 0 ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'} p-3 rounded-xl border text-xs font-semibold">
                    🚨 Log Pindah Tab: <span class="font-bold">${sub.cheatCount} kali terdeteksi</span>
                </div>` : ''}

                <div class="bg-indigo-50 border border-indigo-100 p-4 rounded-xl text-xs space-y-1 mb-2">
                    <p class="font-bold text-indigo-900">✨ Analisis AI:</p>
                    <p class="text-indigo-800 font-medium">${sub.aiReview}</p>
                </div>

                <div>
                    <label class="block text-[11px] font-bold text-slate-700 mb-1">Berikan Catatan Akhir (Untuk Siswa):</label>
                    <textarea id="reviewNote_${sub.id}" class="w-full p-3 rounded-xl border border-slate-300 text-xs outline-none focus:ring-2 focus:ring-emerald-500" placeholder="Ketik apresiasi atau perbaikan..."></textarea>
                </div>
                
                <button onclick="publishReview(${sub.id})" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 rounded-xl text-xs transition shadow-md mt-2">
                    Publikasikan Nilai & Catatan ke Siswa
                </button>
                <button onclick="deleteSubmission(${sub.id})" class="w-full bg-rose-100 hover:bg-rose-200 text-rose-700 font-bold py-2.5 rounded-xl text-xs transition">
                    Hapus Kiriman
                </button>
            </div>
        `).join('');
        const reviewedMarkup = reviewedSubmissions.map((sub, index) => `
            ${index === 0 || `${reviewedSubmissions[index - 1].classId}-${reviewedSubmissions[index - 1].taskType}-${reviewedSubmissions[index - 1].taskTitle}` !== `${sub.classId}-${sub.taskType}-${sub.taskTitle}` ? groupHeader(sub) : ''}
            <div class="bg-emerald-50/60 rounded-2xl p-5 border border-emerald-100"><div class="flex flex-wrap items-start justify-between gap-3"><div><h4 class="font-extrabold text-slate-900">${escapeHtml(sub.nama)}</h4><p class="text-xs text-slate-500 mt-1">${escapeHtml(sub.email || '-')} · ${escapeHtml(sub.timestamp || '-')}</p></div><span class="text-2xl font-black text-emerald-700">${escapeHtml(sub.finalScore ?? sub.aiScore ?? '-')}</span></div><div class="mt-3 space-y-3">${getTaskReviewMarkup(sub)}<div class="bg-white rounded-xl p-3 border border-emerald-100"><p class="text-[10px] font-black uppercase text-emerald-700">Jawaban Siswa</p><p class="text-sm text-slate-700 mt-1 whitespace-pre-wrap">${escapeHtml(sub.jawaban || '-')}</p>${getSubmissionAttachmentsMarkup(sub)}</div><div class="bg-white rounded-xl p-3 border border-emerald-100"><p class="text-[10px] font-black uppercase text-emerald-700">Feedback Guru</p><p class="text-sm text-slate-700 mt-1 whitespace-pre-wrap">${escapeHtml(sub.teacherNote || 'Belum ada feedback')}</p></div></div><button onclick="deleteReviewedSubmission(${sub.id})" class="w-full mt-3 bg-rose-100 hover:bg-rose-200 text-rose-700 font-bold py-2.5 rounded-xl text-xs transition">Hapus Nilai & Feedback</button></div>
        `).join('');
        reviewContainer.innerHTML = `<section class="space-y-4"><div class="flex items-center justify-between"><h4 class="text-base font-black text-slate-900">Perlu Dinilai <span class="text-xs text-amber-600">(${pendingSubmissions.length})</span></h4></div>${pendingMarkup || '<p class="text-sm text-slate-500 border border-dashed border-slate-300 rounded-xl p-6">Tidak ada kiriman yang perlu dinilai pada filter ini.</p>'}</section><section class="space-y-4 pt-5 border-t border-slate-200"><div class="flex items-center justify-between"><h4 class="text-base font-black text-slate-900">Nilai & Feedback <span class="text-xs text-emerald-600">(${reviewedSubmissions.length})</span></h4></div>${reviewedMarkup || '<p class="text-sm text-slate-500 border border-dashed border-slate-300 rounded-xl p-6">Belum ada nilai pada filter ini.</p>'}</section>`;
    }
}

async function saveClassByGuru(e) {
    e.preventDefault();
    const form = e.target;
    const editingId = Number(form.dataset.editingId || 0);
    const name = document.getElementById('guruClassName').value.trim();
    const description = document.getElementById('guruClassDescription').value.trim();
    if (editingId) {
        const currentClass = state.classes.find(item => item.id === editingId);
        if (currentClass) { currentClass.nama = name; currentClass.deskripsi = description; }
        delete form.dataset.editingId;
    } else {
        state.classes.unshift({ id: Date.now(), nama: name, deskripsi: description, materi: [] });
    }
    await saveLearningContent();
    form.reset();
    customAlert(editingId ? 'Kelas berhasil diperbarui.' : 'Kelas baru berhasil ditambahkan.', 'Kelas Tersimpan');
    renderGuruView();
}

function editClassByGuru(id) {
    const currentClass = state.classes.find(item => item.id === id);
    const form = document.getElementById('guruClassForm');
    if (!currentClass || !form) return;
    document.getElementById('guruClassName').value = currentClass.nama;
    document.getElementById('guruClassDescription').value = currentClass.deskripsi || '';
    form.dataset.editingId = id;
    document.getElementById('guruClassName').focus();
}

function deleteClassByGuru(id) {
    const currentClass = state.classes.find(item => item.id === id);
    if (!currentClass) return;
    customConfirm(`Hapus kelas "${currentClass.nama}" beserta materi dan soal yang terhubung?`, async () => {
        state.classes = state.classes.filter(item => item.id !== id);
        removeClassNotifications(id);
        state.materiList = state.materiList.filter(item => item.classId !== id);
        Object.keys(state.taskList).forEach(type => {
            state.taskList[type] = state.taskList[type].filter(item => item.classId !== id);
        });
        state.users.forEach(user => {
            if (user.classId === id) delete user.classId;
        });
        if (Number(document.getElementById('guruClassForm')?.dataset.editingId) === id) {
            document.getElementById('guruClassForm').reset();
            delete document.getElementById('guruClassForm').dataset.editingId;
        }
        await saveLearningContent();
        renderGuruView();
        customAlert(`Kelas "${currentClass.nama}" berhasil dihapus.`, 'Kelas Dihapus');
    });
}

async function submitSiswaWork(type, confirmed = false) {
    saveCurrentStudentQuestion(type);
    const session = activeStudentQuestion[type];
    const taskId = parseInt(document.getElementById(`siswa${type}ActiveId`)?.value || "0");

    const taskObj = state.taskList[type].find(t => t.id === taskId);
    if (!taskObj || new Date(taskObj.closeDate).getTime() <= Date.now()) {
        customAlert('Waktu pengerjaan sudah habis. Jawaban tidak dapat dikirim lagi.', 'Waktu Habis');
        closeStudentTask(type);
        return;
    }
    const answers = session ? session.answers : [];
    const hasAnswer = answers.some(item => item.answer || item.fileName);

    if (!hasAnswer) {
        customAlert("Silakan isi jawaban di kotak teks atau unggah file!");
        return;
    }

    if (['Lkpd', 'Latihan', 'Evaluasi'].includes(type) && !confirmed) {
        customConfirm(`Apakah kamu yakin ingin mengirim jawaban ${type} ini? Setelah dikirim, jawaban tidak dapat diubah.`, () => submitSiswaWork(type, true), `Konfirmasi Pengiriman ${type}`, 'Tidak', 'Yakin, Kirim');
        return;
    }

    const answerText = answers.map((item, index) => {
        const question = normalizeQuestion(taskObj.questions[index]);
        if (question.type === 'choice' && item.answer !== '') {
            const optionIndex = Number(item.answer);
            const option = question.options?.[optionIndex];
            if (option !== undefined) return `Soal ${index + 1}: ${String.fromCharCode(65 + optionIndex)}. ${option}`;
        }
        return `Soal ${index + 1}: ${item.answer || '[Lampiran File]'}`;
    }).join('\n\n');
    const fileNames = answers.filter(item => item.fileName).map((item, index) => `Soal ${index + 1}: ${item.fileName}`);

    const submission = {
        id: Date.now(),
        taskId: taskId,
        taskType: type,
        taskTitle: taskObj ? taskObj.title : `Tugas ${type}`,
        nama: state.currentUser ? state.currentUser.nama : 'Budi Santoso',
        email: state.currentUser ? state.currentUser.email : '-',
        classId: taskObj ? taskObj.classId : null,
        jawaban: answerText,
        fileName: fileNames.join(', '),
        timestamp: new Date().toLocaleString('id-ID'),
        cheatCount: session?.cheatCount || 0,
        status: 'pending',
        aiScore: "...",
        aiReview: "Sedang diproses AI..."
    };

    try {
        const attachments = answers
            .map((item, index) => item.file ? { file: item.file, questionIndex: index } : null)
            .filter(Boolean);
        submission.attachments = await uploadStudentAttachments(attachments, submission.id);
        await saveSubmissionToFirestore(submission);
    } catch (error) {
        console.error('Gagal menyimpan kiriman siswa:', error);
        const message = error.message?.startsWith('Ukuran foto') || error.message?.startsWith('Foto ') || error.message?.startsWith('File yang dipilih')
            ? error.message
            : 'Foto atau jawaban gagal disimpan. Periksa koneksi dan Firestore Rules lalu coba lagi.';
        customAlert(message, 'Pengiriman Gagal');
        return;
    }

    state.studentSubmissions.unshift(submission);
    state.notifications
        .filter(notification => Number(notification.contentId) === Number(taskId) && notification.contentType === type)
        .forEach(notification => dismissStudentNotification(notification.id));
    saveState();
    renderSiswaView();

    // Simulate AI grading logic asynchronously
    setTimeout(() => {
        const graded = state.studentSubmissions.find(s => s.id === submission.id);
        if (graded) {
            graded.aiScore = Math.floor(Math.random() * 20) + 80;
            graded.aiReview = "Berdasarkan analisis algoritma AI: Langkah penyelesaian logis dan penerapan rumus Pythagoras tepat.";
            updateSubmissionInFirestore(graded.id, { aiScore: graded.aiScore, aiReview: graded.aiReview }).catch(error => {
                console.error('Gagal menyinkronkan analisis kiriman:', error);
            });
            saveState();
        }
    }, 2000);

    customAlert(`✅ Jawaban ${type} berhasil dikirimkan!\nGuru akan meninjau hasil dan memberikan nilai. Pantau tab 'Hasil & Review'.`, "Berhasil Terkirim");
    closeStudentTask(type);
}

async function uploadStudentAttachments(attachments, submissionId) {
    if (!attachments.length) return [];
    return Promise.all(attachments.map(async ({ file, questionIndex }) => {
        if (!file.type.startsWith('image/')) {
            throw new Error('File yang dipilih harus berupa foto.');
        }
        if (file.size > 12 * 1024 * 1024) {
            throw new Error(`Foto ${file.name} melebihi batas 12 MB sebelum kompresi.`);
        }

        const bitmap = await createImageBitmap(file);
        const maxDimension = 1280;
        const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();

        let dataUrl = '';
        for (const quality of [0.76, 0.62, 0.48, 0.35]) {
            dataUrl = canvas.toDataURL('image/jpeg', quality);
            if (dataUrl.length <= 250 * 1024) break;
        }
        canvas.width = 0;
        canvas.height = 0;
        if (dataUrl.length > 250 * 1024) {
            throw new Error(`Foto ${file.name} terlalu besar setelah dikompres. Pilih foto yang lebih kecil.`);
        }

        return {
            questionIndex,
            fileName: file.name,
            contentType: 'image/jpeg',
            url: dataUrl
        };
    }));
}

async function publishReview(submissionId) {
    const sub = state.studentSubmissions.find(s => s.id === submissionId);
    if (sub) {
        const note = document.getElementById(`reviewNote_${submissionId}`)?.value;
        const finalScore = document.getElementById(`finalScore_${submissionId}`)?.value;
        const review = {
            teacherNote: note,
            finalScore: finalScore || sub.aiScore,
            status: 'reviewed'
        };
        try {
            await updateSubmissionInFirestore(submissionId, review);
        } catch (error) {
            console.error('Gagal menyimpan penilaian:', error);
            customAlert('Nilai belum berhasil disimpan ke server. Periksa koneksi dan Firestore Rules.', 'Gagal Menyimpan Nilai');
            return;
        }
        Object.assign(sub, review);
        saveState();
        customAlert(`Nilai untuk ${sub.nama} berhasil dipublikasikan.`, "Sukses");
        renderGuruView();
    }
}

function getSubmissionQuestionText(submission) {
    const tasks = state.taskList[submission.taskType] || [];
    const task = tasks.find(item => Number(item.id) === Number(submission.taskId));
    return (task?.questions || [])
        .map(question => typeof question === 'string' ? question : question?.text || '')
        .filter(Boolean)
        .join('\n\n') || '-';
}

function getStudentResultRows() {
    const classValue = document.getElementById('reviewClassFilter')?.value || 'all';
    const typeValue = document.getElementById('reviewTypeFilter')?.value || 'all';
    const taskValue = document.getElementById('reviewTaskFilter')?.value || 'all';
    return state.studentSubmissions.filter(submission => {
        return (classValue === 'all' || String(submission.classId || '') === classValue)
            && (typeValue === 'all' || submission.taskType === typeValue)
            && (taskValue === 'all' || `${submission.taskType}|${submission.taskTitle}` === taskValue);
    }).map(submission => ({
        nama: submission.nama || '-',
        email: submission.email || '-',
        kelas: getClassName(submission.classId),
        jenis: submission.taskType || '-',
        tugas: submission.taskTitle || '-',
        soal: getSubmissionQuestionText(submission),
        jawaban: submission.jawaban || '-',
        dikumpulkan: submission.timestamp || '-',
        nilaiAi: submission.aiScore ?? '-',
        nilai: submission.finalScore ?? submission.aiScore ?? '-',
        analisisAi: submission.aiReview || '-',
        feedback: submission.teacherNote || 'Belum ada feedback',
        status: submission.status === 'reviewed' ? 'Sudah dinilai' : 'Menunggu review',
        lampiran: submission.fileName || '-',
        pindahTab: submission.cheatCount || 0
    }));
}

function getReviewExportLabel() {
    const classFilter = document.getElementById('reviewClassFilter');
    const typeFilter = document.getElementById('reviewTypeFilter');
    const taskFilter = document.getElementById('reviewTaskFilter');
    const classLabel = classFilter?.selectedOptions[0]?.textContent || 'Semua Kelas';
    const typeLabel = typeFilter?.selectedOptions[0]?.textContent || 'Semua Jenis';
    const taskLabel = taskFilter?.selectedOptions[0]?.textContent || 'Semua Pertemuan';
    return [classLabel, typeLabel, taskLabel].filter(label => !label.toLowerCase().startsWith('semua')).map(label => label.replace(/[^a-z0-9]+/gi, '-')).filter(Boolean).join('-') || 'semua-hasil';
}

function exportStudentResultsCsv() {
    const rows = getStudentResultRows();
    if (!rows.length) {
        customAlert('Belum ada hasil siswa yang dapat diunduh.', 'Data Kosong');
        return;
    }
    const headers = ['Nama Siswa', 'Email', 'Kelas', 'Jenis', 'Sesi / Materi', 'Soal', 'Jawaban Siswa', 'Waktu Pengumpulan', 'Nilai AI', 'Nilai Akhir', 'Analisis AI', 'Feedback Guru', 'Status', 'Lampiran', 'Pindah Tab'];
    const values = rows.map(row => [row.nama, row.email, row.kelas, row.jenis, row.tugas, row.soal, row.jawaban, row.dikumpulkan, row.nilaiAi, row.nilai, row.analisisAi, row.feedback, row.status, row.lampiran, row.pindahTab]);
    const csv = [headers, ...values].map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    downloadBlob(`hasil-${getReviewExportLabel()}-${new Date().toISOString().slice(0, 10)}.csv`, `\ufeff${csv}`, 'text/csv;charset=utf-8');
}

function exportStudentResultsExcel() {
    const rows = getStudentResultRows();
    if (!rows.length) {
        customAlert('Belum ada hasil siswa pada filter yang dipilih.', 'Data Kosong');
        return;
    }
    if (!window.XLSX) {
        customAlert('Modul Excel belum termuat. Periksa koneksi internet lalu muat ulang halaman.', 'Ekspor Gagal');
        return;
    }

    const headers = ['Nama Siswa', 'Email', 'Kelas', 'Jenis', 'Sesi / Materi', 'Soal', 'Jawaban Siswa', 'Waktu Pengumpulan', 'Nilai AI', 'Nilai Akhir', 'Analisis AI', 'Feedback Guru', 'Status', 'Lampiran', 'Pindah Tab'];
    const values = rows.map(row => [row.nama, row.email, row.kelas, row.jenis, row.tugas, row.soal, row.jawaban, row.dikumpulkan, row.nilaiAi, row.nilai, row.analisisAi, row.feedback, row.status, row.lampiran, row.pindahTab]);
    const worksheet = XLSX.utils.aoa_to_sheet([
        ['Laporan Hasil Pengerjaan Siswa'],
        ['Filter', getReviewExportLabel()],
        ['Tanggal Ekspor', new Date().toLocaleString('id-ID')],
        ['Jumlah Hasil', rows.length],
        [],
        headers,
        ...values
    ]);
    worksheet['!cols'] = [18, 28, 20, 14, 30, 42, 42, 22, 12, 12, 42, 42, 18, 28, 14].map(wch => ({ wch }));
    worksheet['!autofilter'] = { ref: `A6:O${rows.length + 6}` };
    worksheet['!freeze'] = { xSplit: 0, ySplit: 6 };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Hasil Siswa');
    XLSX.writeFile(workbook, `hasil-${getReviewExportLabel()}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function exportStudentResultsPdf() {
    const rows = getStudentResultRows();
    if (!rows.length) {
        customAlert('Belum ada hasil siswa yang dapat dicetak.', 'Data Kosong');
        return;
    }
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
        customAlert('Izinkan pop-up browser untuk membuat laporan PDF.', 'Pop-up Diblokir');
        return;
    }
    reportWindow.document.write(`<!doctype html><html lang="id"><head><meta charset="UTF-8"><title>Hasil Siswa - ${escapeHtml(getReviewExportLabel())}</title><style>@page{size:A4 landscape;margin:12mm}body{font-family:Arial,sans-serif;color:#172033;padding:24px}h1{font-size:20px;margin:0 0 8px}.meta{font-size:10px;color:#596579;margin-bottom:16px}table{width:100%;border-collapse:collapse;font-size:8px;table-layout:fixed}th,td{border:1px solid #cbd5e1;padding:5px;vertical-align:top;text-align:left;overflow-wrap:anywhere;white-space:pre-wrap}th{background:#e2e8f0;font-size:8px}thead{display:table-header-group}tr{break-inside:avoid}.student{width:12%}.session{width:12%}.question,.answer,.analysis,.feedback{width:15%}.score{width:7%}.metaCol{width:9%}@media print{body{padding:0}}</style></head><body><h1>Laporan Hasil Pengerjaan Siswa</h1><p class="meta">Filter: ${escapeHtml(getReviewExportLabel())}<br>Dibuat: ${escapeHtml(new Date().toLocaleString('id-ID'))} | Total data: ${rows.length}</p><table><thead><tr><th class="student">Siswa / Email</th><th class="session">Kelas / Sesi</th><th class="question">Soal</th><th class="answer">Jawaban / Lampiran</th><th class="score">Nilai AI / Akhir</th><th class="metaCol">Status / Waktu</th><th class="analysis">Analisis AI</th><th class="feedback">Feedback Guru</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.nama)}<br>${escapeHtml(row.email)}</td><td>${escapeHtml(row.kelas)}<br>${escapeHtml(row.jenis)}<br>${escapeHtml(row.tugas)}</td><td>${escapeHtml(row.soal)}</td><td>${escapeHtml(row.jawaban)}<br><br>Lampiran: ${escapeHtml(row.lampiran)}</td><td>AI: ${escapeHtml(row.nilaiAi)}<br>Akhir: ${escapeHtml(row.nilai)}</td><td>${escapeHtml(row.status)}<br>${escapeHtml(row.dikumpulkan)}<br>Pindah tab: ${escapeHtml(row.pindahTab)}</td><td>${escapeHtml(row.analisisAi)}</td><td>${escapeHtml(row.feedback)}</td></tr>`).join('')}</tbody></table><script>window.onload=function(){window.print();}</script></body></html>`);
    reportWindow.document.close();
}

function downloadBlob(filename, content, type) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([content], { type }));
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}

async function addMateriByGuru(e) {
    e.preventDefault();
    const form = e.target;
    const editingId = Number(form.dataset.editingId || 0);
    const uploadedFile = document.getElementById('guruMateriUpload').files[0];
    if (uploadedFile && uploadedFile.size > 400 * 1024) {
        customAlert('File materi melebihi batas 400 KB. Pilih file yang lebih kecil.', 'File Terlalu Besar');
        return;
    }
    let uploadedFileUrl = '';
    if (uploadedFile) {
        try {
            uploadedFileUrl = await readAnyFileAsDataUrl(uploadedFile);
        } catch (error) {
            customAlert('File materi gagal dibaca. Pilih file lain lalu coba lagi.', 'Upload Gagal');
            return;
        }
    }
    const linkedFile = document.getElementById('guruMateriLinkFile').value;
    const materialFile = uploadedFileUrl || linkedFile || form.dataset.existingUploadedFile || '';
    const materialFileName = uploadedFile?.name || (materialFile === form.dataset.existingUploadedFile ? form.dataset.existingUploadedFileName || '' : '');
    const newM = {
        id: editingId || Date.now(),
        judul: document.getElementById('guruMateriJudul').value,
        deskripsi: document.getElementById('guruMateriDeskripsi').value,
        yt: document.getElementById('guruMateriLinkYt').value,
        file: materialFile,
        fileName: materialFileName,
        classId: Number(document.getElementById('guruMateriClass').value)
    };
    const nextMateriList = editingId
        ? state.materiList.map(item => item.id === editingId ? newM : item)
        : [newM, ...state.materiList];
    const projectedContent = {
        classes: state.classes,
        materiList: nextMateriList,
        taskList: state.taskList,
        notifications: state.notifications
    };
    if (new Blob([JSON.stringify(projectedContent)]).size > 900 * 1024) {
        customAlert('File tidak dapat ditambahkan karena total data pembelajaran akan melebihi batas penyimpanan. Gunakan file yang lebih kecil atau hapus file lama.', 'Penyimpanan Penuh');
        return;
    }
    if (editingId) {
        state.materiList = nextMateriList;
        delete form.dataset.editingId;
    } else {
        state.materiList = nextMateriList;
        addStudentNotification('Materi', newM.judul, newM.classId, newM.id, 'Materi');
    }
    const syncResult = await saveLearningContent();
    if (syncResult !== false) {
        customAlert(syncResult ? 'Materi tersimpan dan tersinkron ke Firestore.' : 'Materi tersimpan di perangkat ini saja karena Firebase belum aktif.', 'Materi Tersimpan');
    }
    e.target.reset();
    delete form.dataset.existingUploadedFile;
    delete form.dataset.existingUploadedFileName;
    renderGuruView();
}

function editMateri(id) {
    const materi = state.materiList.find(item => item.id === id);
    const form = document.querySelector('#guruMateriListContainer')?.closest('.bg-white')?.querySelector('form');
    if (!materi || !form) return;
    document.getElementById('guruMateriJudul').value = materi.judul;
    document.getElementById('guruMateriDeskripsi').value = materi.deskripsi;
    document.getElementById('guruMateriLinkYt').value = materi.yt || '';
    const isUploadedFile = materi.file?.startsWith('data:');
    document.getElementById('guruMateriLinkFile').value = isUploadedFile ? '' : materi.file || '';
    document.getElementById('guruMateriClass').value = materi.classId || state.classes[0]?.id || '';
    form.dataset.editingId = id;
    form.dataset.existingUploadedFile = isUploadedFile ? materi.file : '';
    form.dataset.existingUploadedFileName = isUploadedFile ? materi.fileName || '' : '';
    switchTeacherTab('materi');
}

function deleteMateri(id) {
    customConfirm("Apakah Anda yakin ingin menghapus materi ini?", async () => {
        state.materiList = state.materiList.filter(m => m.id !== id);
        removeContentNotification(id, 'Materi');
        await saveLearningContent();
        renderGuruView();
    });
}

async function saveNewTask(e, type) {
    e.preventDefault();
    const editors = [...document.querySelectorAll(`#form${type}Questions .question-editor`)];
    if (!editors.length) {
        customAlert('Klik Tambah Soal lalu isi minimal satu soal.', 'Soal Belum Dibuat');
        return;
    }
    const submitButton = e.target.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    let questionFields;
    try {
        questionFields = (await Promise.all(editors.map(async editor => {
            const kind = editor.querySelector('.question-type').value;
            const text = editor.querySelector('.question-text').value.trim();
            const imageInput = editor.querySelector('.question-image');
            const image = imageInput.files[0] ? await readFileAsDataUrl(imageInput.files[0]) : (editor.dataset.image || '');
            const options = [...editor.querySelectorAll('.question-option')].map(input => input.value.trim());
            while (options.length && !options[options.length - 1]) options.pop();
            const correctAnswer = editor.querySelector('.question-correct')?.value || '';
            return { type: kind, text, image, options, correctAnswer };
        }))).filter(question => question.text || question.image || (question.type === 'choice' && question.options.length >= 2));
    } catch (error) {
        if (submitButton) submitButton.disabled = false;
        customAlert('Foto soal gagal dibaca. Pilih file gambar JPG, PNG, atau WEBP lalu coba lagi.', 'Upload Gagal');
        return;
    }
    if (questionFields.length === 0) {
        customAlert('Tambahkan minimal satu soal terlebih dahulu.', 'Kesalahan Input');
        if (submitButton) submitButton.disabled = false;
        return;
    }
    if (questionFields.some(question => question.type === 'image' && !question.image)) {
        customAlert('Pilih foto untuk setiap soal bertipe foto.', 'Kesalahan Input');
        if (submitButton) submitButton.disabled = false;
        return;
    }
    if (questionFields.some(question => question.type === 'choice' && (
        question.options.length < 2
        || question.options.some(option => !option)
        || question.correctAnswer === ''
        || !Number.isInteger(Number(question.correctAnswer))
        || question.options[Number(question.correctAnswer)] === undefined
    ))) {
        customAlert('Pilihan ganda harus memiliki minimal dua opsi terisi tanpa celah dan jawaban benar yang termasuk dalam opsi.', 'Kesalahan Input');
        if (submitButton) submitButton.disabled = false;
        return;
    }
    const classId = Number(document.getElementById(`form${type}Class`).value);
    if (!classId || !state.classes.some(item => item.id === classId)) {
        customAlert('Pilih kelas tujuan sebelum mengunggah soal.', 'Kelas Belum Dipilih');
        if (submitButton) submitButton.disabled = false;
        return;
    }

    const form = e.target;
    const editingId = Number(form.dataset.editingId || 0);
    const newTask = {
        id: editingId || Date.now(),
        title: document.getElementById(`form${type}Title`).value,
        questions: questionFields,
        content: questionFields.map(question => question.text).filter(Boolean).join('\n\n'),
        openDate: document.getElementById(`form${type}Open`).value,
        closeDate: document.getElementById(`form${type}Close`).value
        , classId
    };

    if (new Date(newTask.openDate) >= new Date(newTask.closeDate)) {
        customAlert("Batas waktu (Tutup) harus lebih besar dari Waktu Dibuka.", "Kesalahan Input");
        if (submitButton) submitButton.disabled = false;
        return;
    }

    if (editingId) {
        state.taskList[type] = state.taskList[type].map(item => item.id === editingId ? newTask : item);
        delete form.dataset.editingId;
    } else {
        state.taskList[type].unshift(newTask);
        addStudentNotification(type === 'Lkpd' ? 'LKPD' : type, newTask.title, newTask.classId, newTask.id, type);
    }
    let syncResult;
    try {
        syncResult = await saveLearningContent();
    } catch (error) {
        if (submitButton) submitButton.disabled = false;
        customAlert('Soal tidak tersimpan. Ukuran foto terlalu besar untuk penyimpanan browser. Gunakan foto yang lebih kecil.', 'Penyimpanan Gagal');
        return;
    }
    if (syncResult !== false) {
        customAlert(syncResult ? `${type} berhasil disimpan dan disinkronkan ke Firestore.` : `${type} tersimpan di perangkat ini saja karena Firebase belum aktif.`, 'Tugas Tersimpan');
    }
    e.target.reset();
    if (submitButton) submitButton.disabled = false;
    renderGuruView();
}

function editTask(type, id) {
    const task = state.taskList[type].find(item => item.id === id);
    const form = document.querySelector(`#form${type}Title`)?.closest('form');
    if (!task || !form) return;
    document.getElementById(`form${type}Title`).value = task.title;
    document.getElementById(`form${type}Open`).value = task.openDate;
    document.getElementById(`form${type}Close`).value = task.closeDate;
    document.getElementById(`form${type}Class`).value = task.classId || state.classes[0]?.id || '';
    const questions = document.getElementById(`form${type}Questions`);
    questions.innerHTML = '';
    task.questions.forEach(question => addQuestionField(type, question));
    form.dataset.editingId = id;
    switchTeacherTab(type.toLowerCase());
}

function deleteSubmission(id) {
    customConfirm('Hapus kiriman siswa ini dari daftar review?', async () => {
        try {
            await deleteSubmissionFromFirestore(id);
        } catch (error) {
            console.error('Gagal menghapus kiriman siswa:', error);
            customAlert('Kiriman belum berhasil dihapus dari server.', 'Gagal Menghapus');
            return;
        }
        state.studentSubmissions = state.studentSubmissions.filter(item => item.id !== id);
        saveState();
        renderGuruView();
    });
}

function deleteReviewedSubmission(id) {
    customConfirm('Hapus hasil penilaian dan feedback siswa ini?', async () => {
        try {
            await deleteSubmissionFromFirestore(id);
        } catch (error) {
            console.error('Gagal menghapus hasil penilaian:', error);
            customAlert('Hasil belum berhasil dihapus dari server.', 'Gagal Menghapus');
            return;
        }
        state.studentSubmissions = state.studentSubmissions.filter(item => item.id !== id);
        saveState();
        renderGuruView();
        customAlert('Hasil penilaian dan feedback berhasil dihapus.', 'Hasil Dihapus');
    });
}

function addQuestionField(type, value = '') {
    const container = document.getElementById(`form${type}Questions`);
    if (!container) return;
    const question = normalizeQuestion(value);
    const questionNumber = container.children.length + 1;
    const editorId = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const textInputId = `questionText_${editorId}`;
    const field = document.createElement('div');
    field.className = 'question-editor bg-white p-4 rounded-xl border border-slate-200 space-y-3';
    field.dataset.image = question.image || '';
    field.innerHTML = `
        <div class="flex items-center justify-between gap-3"><span class="text-xs font-bold text-slate-500">Soal ${questionNumber}</span><button type="button" onclick="this.closest('.question-editor').remove(); renumberQuestionFields('${type}')" class="text-rose-600 font-bold text-lg" aria-label="Hapus soal">×</button></div>
        <select class="question-type w-full p-3 rounded-xl border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-indigo-500" onchange="toggleQuestionEditor(this)">
            <option value="text" ${question.type === 'text' ? 'selected' : ''}>Soal teks (foto opsional)</option>
            <option value="image" ${question.type === 'image' ? 'selected' : ''}>Soal berupa foto</option>
            <option value="choice" ${question.type === 'choice' ? 'selected' : ''}>Pilihan ganda (foto opsional)</option>
        </select>
        <textarea id="${textInputId}" rows="3" class="question-text w-full p-3 rounded-xl border border-slate-300 text-sm outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Tulis pertanyaan ke-${questionNumber}...">${escapeHtml(question.text)}</textarea>
        <button type="button" onclick="showEquationKeyboard('${textInputId}')" class="equation-key px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-bold">Tambah simbol persamaan</button>
        <div class="question-image-wrap"><label class="block text-xs font-bold text-slate-700 mb-1">Foto soal (opsional, bisa digabung dengan teks atau pilihan ganda):</label><div class="flex flex-wrap items-center gap-3"><input type="file" accept="image/*" capture="environment" class="question-image min-w-0 flex-1 block w-full text-sm text-slate-500"><button type="button" onclick="openTeacherQuestionCamera('${type}', this.closest('.question-editor').querySelector('.question-image'))" class="shrink-0 rounded-lg bg-indigo-100 px-4 py-2.5 text-xs font-bold text-indigo-800 hover:bg-indigo-200">Ambil Foto</button></div></div>
        <div class="question-choice-wrap space-y-2"><label class="block text-xs font-bold text-slate-700">Opsi jawaban:</label>${[0, 1, 2, 3].map(index => { const optionId = `questionOption_${editorId}_${index}`; return `<div><div class="flex gap-2"><input id="${optionId}" class="question-option min-w-0 flex-1 p-2.5 rounded-lg border border-slate-300 text-sm" value="${escapeHtml(question.options[index] || '')}" placeholder="Opsi ${String.fromCharCode(65 + index)}"><button type="button" onclick="showEquationKeyboard('${optionId}')" class="equation-key px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-bold" aria-label="Tambah simbol pada opsi ${String.fromCharCode(65 + index)}">∑</button></div></div>`; }).join('')}<label class="block text-xs font-bold text-slate-700">Jawaban benar:</label><select class="question-correct w-full p-2.5 rounded-lg border border-slate-300 text-sm"><option value="">Pilih jawaban benar</option>${[0, 1, 2, 3].map(index => `<option value="${index}" ${String(question.correctAnswer) === String(index) ? 'selected' : ''}>Opsi ${String.fromCharCode(65 + index)}</option>`).join('')}</select></div>
    `;
    container.appendChild(field);
    toggleQuestionEditor(field.querySelector('.question-type'));
    renumberQuestionFields(type);
}

function toggleQuestionEditor(typeSelect) {
    const editor = typeSelect.closest('.question-editor');
    const kind = typeSelect.value;
    editor.querySelector('.question-text').classList.toggle('hidden', kind === 'image');
    editor.querySelector('.question-image-wrap').classList.remove('hidden');
    editor.querySelector('.question-choice-wrap').classList.toggle('hidden', kind !== 'choice');
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith('image/')) {
            reject(new Error('File bukan gambar'));
            return;
        }
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => {
            const image = new Image();
            image.onerror = reject;
            image.onload = () => {
                const maxSize = 1400;
                const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(image.width * scale));
                canvas.height = Math.max(1, Math.round(image.height * scale));
                canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.78));
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function readAnyFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
    });
}

function renumberQuestionFields(type) {
    const container = document.getElementById(`form${type}Questions`);
    if (!container) return;
    [...container.children].forEach((field, index) => {
        field.querySelector('span').innerText = `Soal ${index + 1}`;
        field.querySelector('.question-text').placeholder = `Tulis pertanyaan ke-${index + 1}...`;
    });
}

function deleteTask(type, id) {
    customConfirm(`Apakah Anda yakin ingin menghapus data ${type} ini?`, async () => {
        state.taskList[type] = state.taskList[type].filter(t => t.id !== id);
        removeContentNotification(id, type);
        await saveLearningContent();
        renderGuruView();
    });
}

function generateSoalAI(type) {
    const promptInput = document.getElementById(`form${type}Prompt`);
    const promptText = promptInput ? promptInput.value.trim() : "";

    if (!promptText) {
        customAlert("Silakan masukkan instruksi prompt untuk AI terlebih dahulu!", "Peringatan");
        return;
    }

    const container = document.getElementById(`form${type}Questions`);
    if (!container) return;
    if (container.children.length === 0) addQuestionField(type);
    const contentArea = container.querySelector('textarea');
    contentArea.value = "Sedang memproses dengan AI...";
    setTimeout(() => {
        contentArea.value = `Sebuah segitiga siku-siku ABC siku-siku di B dengan panjang sisi AB = 9 cm dan BC = 12 cm. Hitunglah panjang hipotenusa AC! (Topik: ${promptText})`;
        customAlert("Soal berhasil digenerate otomatis oleh AI!", "AI Assistant");
    }, 1200);
}

function updateTriCalc() {
    const a = parseFloat(document.getElementById('calcA')?.value || 0);
    const b = parseFloat(document.getElementById('calcB')?.value || 0);
    const c = Math.sqrt((a * a) + (b * b));

    const cResult = document.getElementById('calcCResult');
    const stepResult = document.getElementById('calcFormulaStep');

    if (cResult) cResult.innerText = c.toFixed(2);
    if (stepResult) {
        stepResult.innerText = `${a}² + ${b}² = ${a*a} + ${b*b} = ${a*a + b*b} → √${a*a + b*b} = ${c.toFixed(2)}`;
    }
}

document.addEventListener("visibilitychange", () => {
    const activeType = Object.keys(activeStudentQuestion).find(type => {
        const detail = document.getElementById(`siswa${type}DetailView`);
        return detail && !detail.classList.contains('hidden');
    });
    const activeSession = activeType ? activeStudentQuestion[activeType] : null;
    if (document.hidden && activeSession && state.currentUser && normalizeRole(state.currentUser.role) === 'student') {
        const timestamp = new Date().toLocaleTimeString();
        activeSession.cheatCount = (activeSession.cheatCount || 0) + 1;
        state.studentCheatLogs.push(timestamp);
        saveState();

        const countDisplay = document.getElementById('cheatCountDisplay');
        const timeDisplay = document.getElementById('cheatTimestamp');
        const cheatModal = document.getElementById('modalAntiCheat');

        if (countDisplay) countDisplay.innerText = activeSession.cheatCount;
        if (timeDisplay) timeDisplay.innerText = timestamp;
        if (cheatModal) cheatModal.classList.remove('hidden');

        const statusBadge = document.getElementById('studentCheatStatus');
        if (statusBadge) statusBadge.innerText = state.studentCheatLogs.length;
    }
});

function closeCheatModal() {
    const cheatModal = document.getElementById('modalAntiCheat');
    if (cheatModal) cheatModal.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
    const adminNavs = Array.from(document.querySelectorAll('.admin-nav'));
    adminNavs.forEach(nav => {
        nav.addEventListener('click', (event) => {
            event.preventDefault();
            const panel = nav.dataset.adminPanel || 'dashboard';
            switchAdminPanel(panel);
        });
    });
});

window.addEventListener('hashchange', () => {
    if (normalizeRole(state.currentUser?.role) === 'student' && window.location.pathname.endsWith('dashboard_siswa.html')) {
        switchStudentTab(getTabFromHash('materi', ['notifikasi', 'materi', 'lkpd', 'latihan', 'evaluasi', 'hasil']));
    }
    if (normalizeRole(state.currentUser?.role) === 'teacher' && window.location.pathname.endsWith('dashboard_guru.html')) {
        switchTeacherTab(getTabFromHash('materi', ['kelas', 'materi', 'lkpd', 'latihan', 'evaluasi', 'review']));
    }
    if (normalizeRole(state.currentUser?.role) === 'admin' && window.location.pathname.endsWith('dashboard_admin.html')) {
        const selected = window.location.hash.replace('#', '') || 'dashboard';
        if (['dashboard', 'konten', 'email', 'akun', 'device', 'backup'].includes(selected)) {
            renderAdminView();
        }
    }
});