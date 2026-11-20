// services/WalletService.js
import { db, auth } from '../config/firebase';
import { apiFetch } from '../config/api';
import { 
  doc, 
  getDoc, 
  updateDoc, 
  increment, 
  collection, 
  addDoc, 
  setDoc, 
  query, 
  where, 
  getDocs,
  runTransaction,
  Timestamp
} from 'firebase/firestore';

export const WalletService = {
  // Get or create wallet for user
  async getOrCreateWallet(userId) {
    try {
      const walletRef = doc(db, 'wallets', userId);
      const walletDoc = await getDoc(walletRef);
      
      if (walletDoc.exists()) {
        return { id: walletDoc.id, ...walletDoc.data() };
      } else {
        // Create new wallet
        const newWallet = {
          userId: userId,
          balance: 0,
          totalEarned: 0,
          totalWithdrawn: 0,
          pendingCommission: 0,
          donationCommission: 0,
          primaryCommission: 0, // NEW: Track primary commission separately
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        };
        await setDoc(walletRef, newWallet);
        return { id: userId, ...newWallet };
      }
    } catch (error) {
      console.error('Error getting wallet:', error);
      throw error;
    }
  },

  // Add commission to wallet (UPDATED to handle primary_commission)
  async addCommission(userId, amount, type, description, referenceId) {
    try {
      const walletRef = doc(db, 'wallets', userId);
      
      // Use transaction for atomic update
      await runTransaction(db, async (transaction) => {
        const walletDoc = await transaction.get(walletRef);
        const walletData = walletDoc.data();
        
        // Determine if this is a donation commission
        const isDonation = type === 'donation_commission' || 
                          description?.toLowerCase().includes('donation') || false;
        
        // Determine if this is a primary commission
        const isPrimary = type === 'primary_commission';
        
        // Update wallet
        const updates = {
          balance: increment(amount),
          totalEarned: increment(amount),
          pendingCommission: increment(amount),
          updatedAt: Timestamp.now()
        };
        
        // If donation commission, update donationCommission field
        if (isDonation) {
          updates.donationCommission = increment(amount);
        }
        
        // If primary commission, update primaryCommission field
        if (isPrimary) {
          updates.primaryCommission = increment(amount);
        }
        
        transaction.update(walletRef, updates);
        
        // Create transaction record
        const transactionRef = doc(collection(db, 'walletTransactions'));
        transaction.set(transactionRef, {
          userId: userId,
          amount: amount,
          type: type, // 'primary_commission', 'secondary_commission', 'donation_commission', 'withdrawal'
          status: 'pending',
          description: description,
          referenceId: referenceId,
          isDonation: isDonation,
          isPrimary: isPrimary, // NEW: Flag for primary commissions
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });
      
      return { success: true };
    } catch (error) {
      console.error('Error adding commission:', error);
      throw error;
    }
  },

  // Add donation commission specifically
  async addDonationCommission(userId, amount, description, referenceId) {
    try {
      const walletRef = doc(db, 'wallets', userId);
      
      await runTransaction(db, async (transaction) => {
        const walletDoc = await transaction.get(walletRef);
        const walletData = walletDoc.data();
        
        transaction.update(walletRef, {
          balance: increment(amount),
          totalEarned: increment(amount),
          pendingCommission: increment(amount),
          donationCommission: increment(amount),
          updatedAt: Timestamp.now()
        });
        
        const transactionRef = doc(collection(db, 'walletTransactions'));
        transaction.set(transactionRef, {
          userId: userId,
          amount: amount,
          type: 'donation_commission',
          status: 'pending',
          description: description,
          referenceId: referenceId,
          isDonation: true,
          isPrimary: false,
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });
      
      return { success: true };
    } catch (error) {
      console.error('Error adding donation commission:', error);
      throw error;
    }
  },

  // Add primary commission specifically (NEW)
  async addPrimaryCommission(userId, amount, description, referenceId) {
    try {
      const walletRef = doc(db, 'wallets', userId);
      
      await runTransaction(db, async (transaction) => {
        const walletDoc = await transaction.get(walletRef);
        const walletData = walletDoc.data();
        
        transaction.update(walletRef, {
          balance: increment(amount),
          totalEarned: increment(amount),
          pendingCommission: increment(amount),
          primaryCommission: increment(amount),
          updatedAt: Timestamp.now()
        });
        
        const transactionRef = doc(collection(db, 'walletTransactions'));
        transaction.set(transactionRef, {
          userId: userId,
          amount: amount,
          type: 'primary_commission',
          status: 'pending',
          description: description,
          referenceId: referenceId,
          isDonation: false,
          isPrimary: true,
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });
      
      return { success: true };
    } catch (error) {
      console.error('Error adding primary commission:', error);
      throw error;
    }
  },

  // Get donation commission total
  async getDonationCommissionTotal(userId) {
    try {
      const walletRef = doc(db, 'wallets', userId);
      const walletDoc = await getDoc(walletRef);
      
      if (walletDoc.exists()) {
        return walletDoc.data().donationCommission || 0;
      }
      return 0;
    } catch (error) {
      console.error('Error getting donation commission total:', error);
      return 0;
    }
  },

  // Get primary commission total (NEW)
  async getPrimaryCommissionTotal(userId) {
    try {
      const walletRef = doc(db, 'wallets', userId);
      const walletDoc = await getDoc(walletRef);
      
      if (walletDoc.exists()) {
        return walletDoc.data().primaryCommission || 0;
      }
      return 0;
    } catch (error) {
      console.error('Error getting primary commission total:', error);
      return 0;
    }
  },

  // Process withdrawal
  async processWithdrawal(userId, amount, bankDetails) {
    try {
      if (!userId) throw new Error('Not signed in');
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount');
      const walletRef = doc(db, 'wallets', userId);
      
      return await runTransaction(db, async (transaction) => {
        const walletDoc = await transaction.get(walletRef);
        if (!walletDoc.exists()) throw new Error('Wallet not found');
        const walletData = walletDoc.data();
        
        if ((walletData.balance || 0) < amount) {
          throw new Error('Insufficient balance');
        }
        
        // Update wallet
        transaction.update(walletRef, {
          balance: increment(-amount),
          totalWithdrawn: increment(amount),
          updatedAt: Timestamp.now()
        });
        
        // Create withdrawal request
        const withdrawalRef = doc(collection(db, 'withdrawals'));
        transaction.set(withdrawalRef, {
          userId: userId,
          amount: amount,
          bankDetails: bankDetails,
          status: 'pending',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
        
        // Create transaction record
        const transactionRef = doc(collection(db, 'walletTransactions'));
        transaction.set(transactionRef, {
          userId: userId,
          amount: -amount,
          type: 'withdrawal',
          status: 'pending',
          referenceId: withdrawalRef.id, // lets approve/reject/payout find and update this row
          description: `Withdrawal request - ${bankDetails.bankName}`,
          isDonation: false,
          isPrimary: false,
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
        
        return { success: true, transactionId: withdrawalRef.id };
      });
    } catch (error) {
      console.error('Error processing withdrawal:', error);
      throw error;
    }
  },

  // Get wallet transactions
  async getWalletTransactions(userId, limit = 50) {
    try {
      const q = query(
        collection(db, 'walletTransactions'),
        where('userId', '==', userId),
        orderBy('createdAt', 'desc'),
        limit(limit)
      );
      
      const querySnapshot = await getDocs(q);
      const transactions = [];
      querySnapshot.forEach((doc) => {
        transactions.push({ id: doc.id, ...doc.data() });
      });
      
      return transactions;
    } catch (error) {
      console.error('Error getting transactions:', error);
      throw error;
    }
  },

  // Get donation transactions only
  async getDonationTransactions(userId, limit = 50) {
    try {
      const q = query(
        collection(db, 'walletTransactions'),
        where('userId', '==', userId),
        where('type', '==', 'donation_commission'),
        orderBy('createdAt', 'desc'),
        limit(limit)
      );
      
      const querySnapshot = await getDocs(q);
      const transactions = [];
      querySnapshot.forEach((doc) => {
        transactions.push({ id: doc.id, ...doc.data() });
      });
      
      return transactions;
    } catch (error) {
      console.error('Error getting donation transactions:', error);
      throw error;
    }
  },

  // Get primary commission transactions only (NEW)
  async getPrimaryCommissionTransactions(userId, limit = 50) {
    try {
      const q = query(
        collection(db, 'walletTransactions'),
        where('userId', '==', userId),
        where('type', '==', 'primary_commission'),
        orderBy('createdAt', 'desc'),
        limit(limit)
      );
      
      const querySnapshot = await getDocs(q);
      const transactions = [];
      querySnapshot.forEach((doc) => {
        transactions.push({ id: doc.id, ...doc.data() });
      });
      
      return transactions;
    } catch (error) {
      console.error('Error getting primary commission transactions:', error);
      throw error;
    }
  },

  // Get wallet summary with breakdown (UPDATED)
  async getWalletSummary(userId) {
    try {
      const wallet = await this.getOrCreateWallet(userId);
      const transactions = await this.getWalletTransactions(userId, 100);
      
      let totalPrimary = 0;
      let totalSecondary = 0;
      let totalDonation = 0;
      let totalWithdrawn = 0;
      let pending = 0;
      
      transactions.forEach((t) => {
        if (t.status === 'pending' || t.status === 'partially_paid') {
          pending += Math.abs(t.amount || 0);
        } else if (t.status === 'completed' || t.status === 'paid') {
          if (t.type === 'primary_commission') {
            totalPrimary += t.amount || 0;
          } else if (t.type === 'secondary_commission') {
            totalSecondary += t.amount || 0;
          } else if (t.type === 'donation_commission') {
            totalDonation += t.amount || 0;
          } else if (t.type === 'withdrawal') {
            totalWithdrawn += Math.abs(t.amount || 0);
          }
        }
      });
      
      return {
        balance: wallet.balance || 0,
        totalEarned: wallet.totalEarned || 0,
        totalWithdrawn: wallet.totalWithdrawn || 0,
        pendingCommission: wallet.pendingCommission || 0,
        donationCommission: wallet.donationCommission || 0,
        primaryCommission: wallet.primaryCommission || 0,
        breakdown: {
          primary: totalPrimary,
          secondary: totalSecondary,
          donation: totalDonation,
          withdrawn: totalWithdrawn,
          pending: pending
        }
      };
    } catch (error) {
      console.error('Error getting wallet summary:', error);
      throw error;
    }
  },

  // Approve withdrawal (Admin): backend creates the Cashfree payout transfer.
  async approveWithdrawal(withdrawalId) {
    const token = await auth.currentUser?.getIdToken();
    return apiFetch(`/api/payouts/withdrawals/${encodeURIComponent(withdrawalId)}/approve`, { method: 'POST', token });
  },

  // Re-read the payout status from Cashfree (use when a webhook was missed).
  async syncWithdrawal(withdrawalId) {
    const token = await auth.currentUser?.getIdToken();
    return apiFetch(`/api/payouts/withdrawals/${encodeURIComponent(withdrawalId)}/sync`, { method: 'POST', token });
  },

  // Reject withdrawal (Admin): backend refunds the wallet atomically and only once.
  async rejectWithdrawal(withdrawalId, reason) {
    const token = await auth.currentUser?.getIdToken();
    return apiFetch(`/api/payouts/withdrawals/${encodeURIComponent(withdrawalId)}/reject`, {
      method: 'POST', token, body: { reason },
    });
  },

  // Get pending withdrawals for a user
  async getPendingWithdrawals(userId) {
    try {
      const q = query(
        collection(db, 'withdrawals'),
        where('userId', '==', userId),
        where('status', '==', 'pending'),
        orderBy('createdAt', 'desc')
      );
      
      const querySnapshot = await getDocs(q);
      const withdrawals = [];
      querySnapshot.forEach((doc) => {
        withdrawals.push({ id: doc.id, ...doc.data() });
      });
      
      return withdrawals;
    } catch (error) {
      console.error('Error getting pending withdrawals:', error);
      return [];
    }
  },

  // Get all pending withdrawals (Admin)
  async getAllPendingWithdrawals() {
    try {
      const q = query(
        collection(db, 'withdrawals'),
        where('status', '==', 'pending'),
        orderBy('createdAt', 'desc')
      );
      
      const querySnapshot = await getDocs(q);
      const withdrawals = [];
      
      for (const doc of querySnapshot.docs) {
        const data = doc.data();
        // Get user details
        const userDoc = await getDoc(doc(db, 'users', data.userId));
        const userData = userDoc.exists() ? userDoc.data() : null;
        
        withdrawals.push({
          id: doc.id,
          ...data,
          userName: userData?.fullName || userData?.name || 'Unknown',
          userEmail: userData?.email || 'Unknown'
        });
      }
      
      return withdrawals;
    } catch (error) {
      console.error('Error getting all pending withdrawals:', error);
      return [];
    }
  }
};