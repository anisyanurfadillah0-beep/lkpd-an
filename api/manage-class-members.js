const admin = require('../lib/firebase-admin');

const db = admin.firestore();
const DELETE_AUDIT_PREFIX = 'user-delete-';

function sendError(response, status, message) {
    response.status(status).json({ error: message });
}

async function authenticate(request) {
    const authorization = request.headers.authorization || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        const error = new Error('Authentication required.');
        error.status = 401;
        throw error;
    }

    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(match[1]);
    } catch {
        const error = new Error('Authentication required.');
        error.status = 401;
        throw error;
    }

    const callerSnapshot = await db.collection('users').doc(decoded.uid).get();
    const role = callerSnapshot.exists ? callerSnapshot.data().role : '';
    if (!['teacher', 'admin'].includes(role)) {
        const error = new Error('You do not have permission to manage class members.');
        error.status = 403;
        throw error;
    }
    return { uid: decoded.uid, role };
}

function normalizeUid(uid) {
    return typeof uid === 'string' && uid.length > 0 && uid.length <= 128 ? uid : '';
}

function getChunks(items, size = 400) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

async function deleteQueryDocuments(query) {
    const snapshot = await query.get();
    await deleteDocuments(snapshot.docs);
}

async function deleteDocuments(documents) {
    for (const chunk of getChunks(documents)) {
        const batch = db.batch();
        chunk.forEach(document => batch.delete(document.ref));
        await batch.commit();
    }
}

async function writeAuditStatus(auditRef, fields) {
    await auditRef.set({
        ...fields,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function removeClassMembership(request, response, actor) {
    const studentUid = normalizeUid(request.body?.studentUid);
    const classId = Number(request.body?.classId);
    if (!studentUid || !Number.isInteger(classId) || classId <= 0) {
        return sendError(response, 400, 'A valid student and class are required.');
    }
    if (studentUid === actor.uid) {
        return sendError(response, 403, 'You cannot remove your own account from a class.');
    }

    const profileRef = db.collection('users').doc(studentUid);
    const profileSnapshot = await profileRef.get();
    if (!profileSnapshot.exists) return sendError(response, 404, 'Student profile not found.');
    const profile = profileSnapshot.data();
    if (profile.role !== 'student') return sendError(response, 403, 'Only student memberships can be removed.');

    const classSnapshot = await db.collection('appData').doc('learningContent').get();
    const classes = classSnapshot.exists ? classSnapshot.data().classes || [] : [];
    const selectedClass = classes.find(item => Number(item.id) === classId);
    if (!selectedClass) return sendError(response, 404, 'Class not found.');

    const auditRef = db.collection('auditLogs').doc();
    const auditData = {
        action: 'remove-class-member',
        actorUid: actor.uid,
        targetUid: studentUid,
        targetName: profile.name || '',
        targetEmail: profile.email || '',
        classId,
        className: selectedClass.nama || '',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'processing'
    };
    await auditRef.set(auditData);

    let phase = 'membership';
    try {
        await profileRef.collection('classMemberships').doc(String(classId)).delete();
        const legacyMemberships = await db.collection('classMembers')
            .where('studentUid', '==', studentUid)
            .get();
        await deleteDocuments(legacyMemberships.docs.filter(document => Number(document.data().classId) === classId));

        phase = 'profile';
        const updates = {};
        if (Number(profile.classId) === classId) updates.classId = admin.firestore.FieldValue.delete();
        if (Array.isArray(profile.classIds)) {
            updates.classIds = profile.classIds.filter(id => Number(id) !== classId);
        }
        if (Object.keys(updates).length) await profileRef.update(updates);

        await writeAuditStatus(auditRef, { status: 'complete' });
        return response.status(200).json({ success: true });
    } catch (error) {
        await writeAuditStatus(auditRef, { status: 'failed', failedPhase: phase }).catch(() => {});
        console.error(`Class membership removal failed during ${phase}.`);
        return sendError(response, 500, `Membership removal could not be completed during ${phase}. Retry the action.`);
    }
}

async function deleteUserAccount(request, response, actor) {
    const targetUid = normalizeUid(request.body?.targetUid);
    if (!targetUid) return sendError(response, 400, 'A valid account is required.');
    if (targetUid === actor.uid) return sendError(response, 403, 'You cannot delete your own account.');

    const profileRef = db.collection('users').doc(targetUid);
    const auditRef = db.collection('auditLogs').doc(`${DELETE_AUDIT_PREFIX}${targetUid}`);
    const [profileSnapshot, auditSnapshot] = await Promise.all([
        profileRef.get(),
        auditRef.get()
    ]);

    let authUser = null;
    try {
        authUser = await admin.auth().getUser(targetUid);
    } catch (error) {
        if (error.code !== 'auth/user-not-found') throw error;
    }

    const previousAudit = auditSnapshot.exists ? auditSnapshot.data() : null;
    const requestedDeleteSubmissions = request.body?.deleteSubmissions === true;
    if (!profileSnapshot.exists && !authUser && previousAudit?.status === 'complete') {
        return response.status(200).json({ success: true, alreadyDeleted: true });
    }
    if (!profileSnapshot.exists && !authUser && !previousAudit) {
        return sendError(response, 404, 'Target account not found.');
    }

    const profile = profileSnapshot.exists ? profileSnapshot.data() : null;
    const targetRole = profile?.role || previousAudit?.targetRole || '';
    if (!['student', 'teacher', 'admin'].includes(targetRole)) {
        return sendError(response, 403, 'Target account role cannot be verified.');
    }
    if (targetRole !== 'student' && actor.role !== 'admin') {
        return sendError(response, 403, 'Only admins may delete teacher or admin accounts.');
    }
    const deleteSubmissions = targetRole === 'student'
        && (requestedDeleteSubmissions || previousAudit?.deleteSubmissions === true);

    const [membershipSnapshot, legacyMembershipSnapshot, learningContentSnapshot] = await Promise.all([
        profileRef.collection('classMemberships').get(),
        db.collection('classMembers').where('studentUid', '==', targetUid).get(),
        db.collection('appData').doc('learningContent').get()
    ]);
    const classIds = new Set([
        ...(Array.isArray(previousAudit?.classIds) ? previousAudit.classIds : []),
        ...membershipSnapshot.docs.map(document => Number(document.data().classId)).filter(Number.isInteger),
        ...legacyMembershipSnapshot.docs.map(document => Number(document.data().classId)).filter(Number.isInteger),
        ...(profile?.classId ? [Number(profile.classId)] : []),
        ...(Array.isArray(profile?.classIds) ? profile.classIds.map(Number).filter(Number.isInteger) : [])
    ]);
    const classes = learningContentSnapshot.exists ? learningContentSnapshot.data().classes || [] : [];
    const classNames = [...classIds].map(classId => classes.find(item => Number(item.id) === classId)?.nama).filter(Boolean);

    let auditData = {
        action: 'delete-user',
        actorUid: previousAudit?.actorUid || actor.uid,
        targetUid,
        targetEmail: profile?.email || authUser?.email || previousAudit?.targetEmail || '',
        targetName: profile?.name || previousAudit?.targetName || '',
        targetRole,
        classIds: [...classIds],
        classNames: previousAudit?.classNames || classNames,
        className: (previousAudit?.classNames || classNames).join(', '),
        deleteSubmissions,
        createdAt: previousAudit?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        status: 'processing'
    };
    if (previousAudit?.status === 'complete') {
        return response.status(200).json({ success: true, alreadyDeleted: true });
    }
    await auditRef.set({
        ...auditData,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    let phase = 'memberships';
    try {
        await deleteDocuments(membershipSnapshot.docs);
        await deleteDocuments(legacyMembershipSnapshot.docs);

        phase = 'profile';
        if (profileSnapshot.exists) await profileRef.delete();

        phase = 'memberships';
        const remainingMemberships = await profileRef.collection('classMemberships').get();
        await deleteDocuments(remainingMemberships.docs);
        await deleteQueryDocuments(db.collection('classMembers').where('studentUid', '==', targetUid));

        phase = 'submissions';
        const submissions = await db.collection('submissions').where('studentUid', '==', targetUid).get();
        for (const chunk of getChunks(submissions.docs)) {
            const batch = db.batch();
            chunk.forEach(document => {
                if (deleteSubmissions) batch.delete(document.ref);
                else batch.update(document.ref, { studentDeleted: true });
            });
            await batch.commit();
        }

        phase = 'authentication';
        if (authUser) {
            try {
                await admin.auth().deleteUser(targetUid);
            } catch (error) {
                if (error.code !== 'auth/user-not-found') throw error;
            }
        }

        await writeAuditStatus(auditRef, {
            ...auditData,
            status: 'complete',
            completedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return response.status(200).json({ success: true });
    } catch (error) {
        await writeAuditStatus(auditRef, {
            ...auditData,
            status: 'failed',
            failedPhase: phase
        }).catch(() => {});
        console.error(`Account deletion failed during ${phase}.`);
        return sendError(response, 500, `Account deletion could not be completed during ${phase}. Retry the action.`);
    }
}

module.exports = async function handler(request, response) {
    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return sendError(response, 405, 'Method not allowed.');
    }

    let actor;
    try {
        actor = await authenticate(request);
    } catch (error) {
        return sendError(response, error.status || 500, error.status ? error.message : 'Unable to verify your account.');
    }

    try {
        if (request.body?.action === 'remove-class-member') {
            return await removeClassMembership(request, response, actor);
        }
        if (request.body?.action === 'delete-user') {
            return await deleteUserAccount(request, response, actor);
        }
        return sendError(response, 400, 'Unsupported action.');
    } catch (error) {
        console.error('User management request failed.');
        return sendError(response, 500, 'The request could not be completed.');
    }
};
