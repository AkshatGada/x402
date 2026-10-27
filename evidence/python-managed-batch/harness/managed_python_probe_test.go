package facilitator

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "net/http/httptest"
    "os"
    "os/exec"
    "strings"
    "sync"
    "testing"

    "github.com/ethereum/go-ethereum/crypto"
    batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
    "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
    "github.com/x402-foundation/x402/go/v2/types"
)

// This validation-only bridge uses the real Go managed scheme and the upstream
// managed tests' synthetic signer/chain reader. It never contacts a chain.
func TestPythonManagedCustodyProbe(t *testing.T) {
    python := os.Getenv("X402_PROBE_PYTHON")
    probe := os.Getenv("X402_PROBE_SCRIPT")
    if python == "" || probe == "" { t.Skip("set X402_PROBE_PYTHON and X402_PROBE_SCRIPT") }
    ctx := context.Background()
    auth := managedAuthorizer()
    refundKey, err := crypto.HexToECDSA(serverRefundKeyHex)
    if err != nil { t.Fatal(err) }
    refundAddress := crypto.PubkeyToAddress(refundKey.PublicKey).Hex()
    var mu sync.Mutex
    var scheme *BatchSettlementEvmScheme
    var store *storage.InMemoryChannelStorage[*FacilitatorChannel]
    var currentID string
    calls := map[string]int{"verify": 0, "settle": 0}
    reset := func(cfg batchsettlement.ChannelConfig, signature string) error {
        store = storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
        currentID, err = batchsettlement.ComputeChannelId(cfg, managedNetwork)
        if err != nil { return err }
        seedManagedChannel(t, store, storedManagedChannel(cfg, currentID, &channelFields{Signature: signature}))
        delegated := storage.NewInMemoryDelegatedAuthStore()
        bindManagedIdentity(t, delegated, currentID, "validation-service")
        scheme, err = NewBatchSettlementEvmSchemeWithConfig(newManagedSigner(t, nil), auth, &BatchSettlementEvmSchemeConfig{
            DelegatedAuthStore: delegated,
            VoucherStore: &VoucherStoreConfig{Storage: store},
            ResolveCallerIdentity: func(DelegatedSettleContext) (string, error) { return "validation-service", nil },
        })
        calls = map[string]int{"verify": 0, "settle": 0}
        return err
    }
    if err := reset(managedIdentityConfig(auth.addr), dummySig); err != nil { t.Fatal(err) }
    handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        mu.Lock()
        defer mu.Unlock()
        w.Header().Set("Content-Type", "application/json")
        encode := func(v interface{}) { if err := json.NewEncoder(w).Encode(v); err != nil { t.Error(err) } }
        switch r.URL.Path {
        case "/fixture":
            encode(map[string]interface{}{"requirements": managedRequirements(auth.addr), "refundAuthorizer": refundAddress})
        case "/supported":
            encode(map[string]interface{}{"kinds": []map[string]interface{}{{"x402Version": 2, "scheme": batchsettlement.SchemeBatched, "network": managedNetwork, "extra": scheme.GetExtra(managedNetwork)}}, "extensions": []string{}, "signers": map[string][]string{}})
        case "/setup":
            var input struct { Config batchsettlement.ChannelConfig `json:"config"`; Signature string `json:"signature"`; Requirements types.PaymentRequirements `json:"requirements"` }
            if err := json.NewDecoder(r.Body).Decode(&input); err != nil { http.Error(w, err.Error(), 400); return }
            if err := reset(input.Config, input.Signature); err != nil { http.Error(w, err.Error(), 400); return }
            canonical := input.Config
            if ra, _ := input.Requirements.Extra["refundAuthorizer"].(string); ra != "" {
                canonical.Salt, err = batchsettlement.PackRefundAuthorizerSalt(input.Config.Salt, ra)
                if err != nil { http.Error(w, err.Error(), 400); return }
            }
            canonicalID, err := batchsettlement.ComputeChannelId(canonical, managedNetwork)
            if err != nil { http.Error(w, err.Error(), 400); return }
            encode(map[string]interface{}{"canonicalConfig": canonical, "canonicalChannelId": canonicalID, "channelId": currentID})
        case "/state":
            channel, err := store.Get(ctx, currentID)
            if err != nil { http.Error(w, err.Error(), 500); return }
            held, err := store.IsHeld(ctx, currentID, "")
            if err != nil { http.Error(w, err.Error(), 500); return }
            encode(map[string]interface{}{"channel": channel, "held": held, "calls": calls})
        case "/verify", "/settle":
            var input struct { PaymentPayload types.PaymentPayload `json:"paymentPayload"`; PaymentRequirements types.PaymentRequirements `json:"paymentRequirements"` }
            if err := json.NewDecoder(r.Body).Decode(&input); err != nil { http.Error(w, err.Error(), 400); return }
            if r.URL.Path == "/verify" {
                calls["verify"]++
                response, err := scheme.Verify(ctx, input.PaymentPayload, input.PaymentRequirements, nil)
                if err != nil { http.Error(w, err.Error(), 500); return }
                encode(response)
            } else {
                calls["settle"]++
                response, err := scheme.Settle(ctx, input.PaymentPayload, input.PaymentRequirements, nil)
                if err != nil { http.Error(w, err.Error(), 500); return }
                encode(response)
            }
        default: http.NotFound(w, r)
        }
    })
    server := httptest.NewServer(handler)
    defer server.Close()
    cmd := exec.Command(python, probe)
    cmd.Env = append(os.Environ(), "X402_PROBE_URL="+server.URL, "PYTHONPATH="+os.Getenv("X402_AUDIT_SOURCE_ROOT")+"/python")
    output, err := cmd.CombinedOutput()
    t.Log(strings.TrimSpace(string(output)))
    if err != nil { t.Fatalf("Python probe failed: %v", err) }
    expected := os.Getenv("X402_PROBE_RESULT")
    if expected == "" { expected = "managed-custody-passed" }
    if !strings.Contains(string(output), `"result":"`+expected+`"`) { t.Fatal(fmt.Sprintf("missing result marker: %s", output)) }
}
