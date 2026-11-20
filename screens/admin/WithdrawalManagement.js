// screens/admin/WithdrawalManagement.js
// Admin: review working-member wallet withdrawals, pay them out through Cashfree Payouts,
// reject (wallet is refunded by the backend) or re-check a payout's status.
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator,
  Modal, TextInput, Alert, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { collection, query, orderBy, limit, onSnapshot, doc, getDoc } from 'firebase/firestore';
import { db } from '../../config/firebase';
import { Fonts } from '../../config/fonts';
import { WalletService } from '../../services/WalletService';

const FILTERS = ['all', 'pending', 'processing', 'paid', 'failed', 'rejected'];
const STATUS_COLOR = {
  pending: '#f59e0b', processing: '#3b82f6', paid: '#10b981',
  approved: '#10b981', failed: '#ef4444', rejected: '#6b7280',
};

const fmtDate = (ts) => {
  const d = ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null;
  return d && !isNaN(d) ? d.toLocaleString() : '';
};
const mask = (n) => (n ? `••••${String(n).slice(-4)}` : '');

export default function WithdrawalManagement() {
  const [items, setItems] = useState([]);
  const [names, setNames] = useState({});
  const [filter, setFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // live list: webhook/sync status changes show up without reloading
  useEffect(() => {
    const q = query(collection(db, 'withdrawals'), orderBy('createdAt', 'desc'), limit(200));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
        setRefreshing(false);
      },
      (err) => {
        console.error('withdrawals listener:', err);
        setLoading(false);
        setRefreshing(false);
        Alert.alert('Error', 'Could not load withdrawals. ' + (err.message || ''));
      }
    );
    return unsub;
  }, [refreshKey]);

  // resolve member names once per user
  useEffect(() => {
    const missing = [...new Set(items.map((i) => i.userId))].filter((u) => u && !names[u]);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(missing.map(async (uid) => {
        try {
          const s = await getDoc(doc(db, 'users', uid));
          const d = s.exists() ? s.data() : {};
          return [uid, d.fullName || d.name || d.email || uid.slice(0, 6)];
        } catch (_) { return [uid, uid.slice(0, 6)]; }
      }));
      if (!cancelled) setNames((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    })();
    return () => { cancelled = true; };
  }, [items, names]);

  const visible = useMemo(
    () => items.filter((i) => filter === 'all' || i.status === filter || (filter === 'paid' && i.status === 'approved')),
    [items, filter]
  );
  const counts = useMemo(() => {
    const c = {};
    items.forEach((i) => { c[i.status] = (c[i.status] || 0) + 1; });
    return c;
  }, [items]);

  const run = useCallback(async (id, fn, okMsg) => {
    setBusyId(id);
    try {
      const r = await fn();
      Alert.alert('Done', okMsg(r));
    } catch (e) {
      Alert.alert('Failed', e.message || 'Something went wrong');
    } finally {
      setBusyId(null);
    }
  }, []);

  const approve = (w) =>
    Alert.alert(
      'Approve & pay',
      `Send ₹${Number(w.amount).toLocaleString()} to ${w.bankDetails?.accountHolderName || names[w.userId] || 'member'} via Cashfree?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pay now',
          onPress: () => run(w.id, () => WalletService.approveWithdrawal(w.id),
            (r) => (r.status === 'paid' ? 'Payout completed.' : 'Payout submitted. Status will update automatically.')),
        },
      ]
    );

  const sync = (w) => run(w.id, () => WalletService.syncWithdrawal(w.id), (r) => `Status: ${r.status}`);

  const confirmReject = async () => {
    const w = rejecting;
    setRejecting(null);
    const why = reason.trim() || 'Rejected by admin';
    setReason('');
    await run(w.id, () => WalletService.rejectWithdrawal(w.id, why), () => 'Rejected. Amount returned to the member wallet.');
  };

  const renderItem = ({ item: w }) => {
    const b = w.bankDetails || {};
    const color = STATUS_COLOR[w.status] || '#6b7280';
    const busy = busyId === w.id;
    return (
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.name} numberOfLines={1}>{names[w.userId] || '…'}</Text>
          <View style={[styles.chip, { backgroundColor: color + '22' }]}>
            <Text style={[styles.chipText, { color }]}>{String(w.status || '').toUpperCase()}</Text>
          </View>
        </View>
        <Text style={styles.amount}>₹{Number(w.amount || 0).toLocaleString()}</Text>
        <Text style={styles.meta}>
          {b.accountNumber ? `${b.bankName || 'Bank'} ${mask(b.accountNumber)} · ${b.ifscCode || ''}` : ''}
          {b.upiId ? `${b.accountNumber ? '  ·  ' : ''}UPI ${b.upiId}` : ''}
        </Text>
        <Text style={styles.meta}>Requested {fmtDate(w.createdAt)}</Text>
        {!!w.utr && <Text style={styles.meta}>UTR {w.utr}</Text>}
        {!!w.transferStatus && w.status === 'processing' && <Text style={styles.meta}>Cashfree: {w.transferStatus}</Text>}
        {!!(w.lastError || w.failureReason || w.reason) && (
          <Text style={styles.error}>{w.failureReason || w.lastError || w.reason}</Text>
        )}
        {w.needsReview && <Text style={styles.error}>Paid after refund — needs manual review</Text>}

        {busy ? (
          <ActivityIndicator style={{ marginTop: 10 }} color="#FF7722" />
        ) : (
          <View style={styles.actions}>
            {w.status === 'pending' && (
              <>
                <TouchableOpacity style={[styles.btn, styles.pay]} onPress={() => approve(w)}>
                  <MaterialIcons name="payments" size={16} color="#fff" />
                  <Text style={styles.btnText}>Approve & Pay</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, styles.reject]} onPress={() => setRejecting(w)}>
                  <Text style={[styles.btnText, { color: '#ef4444' }]}>Reject</Text>
                </TouchableOpacity>
              </>
            )}
            {w.status === 'processing' && (
              <TouchableOpacity style={[styles.btn, styles.sync]} onPress={() => sync(w)}>
                <MaterialIcons name="sync" size={16} color="#3b82f6" />
                <Text style={[styles.btnText, { color: '#3b82f6' }]}>Check status</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Withdrawals</Text>
      <View style={styles.filters}>
        {FILTERS.map((f) => (
          <TouchableOpacity key={f} onPress={() => setFilter(f)} style={[styles.filter, filter === f && styles.filterOn]}>
            <Text style={[styles.filterText, filter === f && { color: '#fff' }]}>
              {f[0].toUpperCase() + f.slice(1)}{f !== 'all' && counts[f] ? ` (${counts[f]})` : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color="#FF7722" />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); setRefreshKey((k) => k + 1); }} />}
          ListEmptyComponent={<Text style={styles.empty}>No withdrawals here.</Text>}
        />
      )}

      <Modal visible={!!rejecting} transparent animationType="fade" onRequestClose={() => setRejecting(null)}>
        <View style={styles.modalBg}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Reject withdrawal</Text>
            <Text style={styles.meta}>₹{Number(rejecting?.amount || 0).toLocaleString()} will be returned to the member's wallet.</Text>
            <TextInput
              style={styles.input}
              placeholder="Reason (shown to member)"
              value={reason}
              onChangeText={setReason}
              multiline
            />
            <View style={styles.actions}>
              <TouchableOpacity style={[styles.btn, styles.sync]} onPress={() => { setRejecting(null); setReason(''); }}>
                <Text style={[styles.btnText, { color: '#374151' }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, styles.pay, { backgroundColor: '#ef4444' }]} onPress={confirmReject}>
                <Text style={styles.btnText}>Reject</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  title: { fontFamily: Fonts.Bold, fontSize: 22, color: '#1f2937', paddingHorizontal: 16, paddingTop: 12 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, paddingTop: 10 },
  filter: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: '#e5e7eb', margin: 4 },
  filterOn: { backgroundColor: '#FF7722' },
  filterText: { fontFamily: Fonts.SemiBold, fontSize: 12, color: '#374151' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 12, elevation: 1,
    shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  name: { fontFamily: Fonts.SemiBold, fontSize: 15, color: '#111827', flex: 1, marginRight: 8 },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  chipText: { fontFamily: Fonts.Bold, fontSize: 10 },
  amount: { fontFamily: Fonts.Bold, fontSize: 22, color: '#FF7722', marginVertical: 4 },
  meta: { fontFamily: Fonts.Regular, fontSize: 12, color: '#6b7280', marginTop: 2 },
  error: { fontFamily: Fonts.Medium, fontSize: 12, color: '#ef4444', marginTop: 4 },
  actions: { flexDirection: 'row', marginTop: 12 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8, marginRight: 8 },
  pay: { backgroundColor: '#10b981' },
  reject: { backgroundColor: '#fee2e2' },
  sync: { backgroundColor: '#e5e7eb' },
  btnText: { fontFamily: Fonts.SemiBold, fontSize: 13, color: '#fff', marginLeft: 4 },
  empty: { textAlign: 'center', marginTop: 40, fontFamily: Fonts.Regular, color: '#9ca3af' },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: '#fff', borderRadius: 14, padding: 18 },
  modalTitle: { fontFamily: Fonts.Bold, fontSize: 17, color: '#111827', marginBottom: 6 },
  input: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, padding: 10, marginTop: 12, minHeight: 70,
    fontFamily: Fonts.Regular, textAlignVertical: 'top' },
});
