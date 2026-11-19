package dev.chronicle.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * API keys and tokens, encrypted with an AES key that lives in the Android Keystore (it never leaves
 * the secure hardware / OS keystore and can't be read out). Only the ciphertext is stored, in private
 * SharedPreferences.
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {
    private static final String ALIAS = "ocm_secrets_v1";
    private static final String PREFS = "ocm_secure";

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return g.generateKey();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void get(PluginCall call) {
        String name = call.getString("name", "secrets");
        JSObject r = new JSObject();
        String stored = prefs().getString(name, null);
        if (stored == null) {
            r.put("value", null);
            call.resolve(r);
            return;
        }
        try {
            String[] parts = stored.split(":", 2);
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] ct = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            r.put("value", new String(c.doFinal(ct), StandardCharsets.UTF_8));
            call.resolve(r);
        } catch (Exception e) {
            // e.g. restored from a cloud backup on a new phone: the keystore key isn't there any more
            call.reject("Could not decrypt the saved keys: " + e.getMessage(), "DECRYPT_FAILED");
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String name = call.getString("name", "secrets");
        String value = call.getString("value");
        try {
            if (value == null) {
                prefs().edit().remove(name).commit();
            } else {
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.ENCRYPT_MODE, key());
                byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
                String out = Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
                if (!prefs().edit().putString(name, out).commit()) throw new Exception("write failed");
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not save the keys securely: " + e.getMessage(), "ENCRYPT_FAILED");
        }
    }
}
