export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      locations: {
        Row: {
          code: string;
          id: string;
          name: string;
          warehouse_id: string;
          workspace_id: string;
        };
        Insert: {
          code: string;
          id?: string;
          name: string;
          warehouse_id: string;
          workspace_id: string;
        };
        Update: {
          code?: string;
          id?: string;
          name?: string;
          warehouse_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "locations_warehouse_id_fkey";
            columns: ["warehouse_id"];
            isOneToOne: false;
            referencedRelation: "warehouses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "locations_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      operation_items: {
        Row: {
          counted_quantity: number | null;
          id: string;
          operation_id: string;
          product_id: string;
          quantity: number;
          workspace_id: string;
        };
        Insert: {
          counted_quantity?: number | null;
          id?: string;
          operation_id: string;
          product_id: string;
          quantity: number;
          workspace_id: string;
        };
        Update: {
          counted_quantity?: number | null;
          id?: string;
          operation_id?: string;
          product_id?: string;
          quantity?: number;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "operation_items_operation_id_fkey";
            columns: ["operation_id"];
            isOneToOne: false;
            referencedRelation: "operations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "operation_items_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "operation_items_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      operations: {
        Row: {
          completed_at: string | null;
          contact: string;
          created_at: string;
          created_by: string;
          destination_location_id: string | null;
          id: string;
          kind: string;
          notes: string;
          packed_at: string | null;
          picked_at: string | null;
          reference: string;
          source_location_id: string | null;
          status: string;
          workspace_id: string;
        };
        Insert: {
          completed_at?: string | null;
          contact?: string;
          created_at?: string;
          created_by: string;
          destination_location_id?: string | null;
          id?: string;
          kind: string;
          notes?: string;
          packed_at?: string | null;
          picked_at?: string | null;
          reference: string;
          source_location_id?: string | null;
          status?: string;
          workspace_id: string;
        };
        Update: {
          completed_at?: string | null;
          contact?: string;
          created_at?: string;
          created_by?: string;
          destination_location_id?: string | null;
          id?: string;
          kind?: string;
          notes?: string;
          packed_at?: string | null;
          picked_at?: string | null;
          reference?: string;
          source_location_id?: string | null;
          status?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "operations_destination_location_id_fkey";
            columns: ["destination_location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "operations_source_location_id_fkey";
            columns: ["source_location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "operations_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      products: {
        Row: {
          archived: boolean;
          category: string;
          created_at: string;
          id: string;
          name: string;
          reorder_point: number;
          sku: string;
          unit: string;
          workspace_id: string;
        };
        Insert: {
          archived?: boolean;
          category?: string;
          created_at?: string;
          id?: string;
          name: string;
          reorder_point?: number;
          sku: string;
          unit?: string;
          workspace_id: string;
        };
        Update: {
          archived?: boolean;
          category?: string;
          created_at?: string;
          id?: string;
          name?: string;
          reorder_point?: number;
          sku?: string;
          unit?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "products_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          created_at: string;
          display_name: string;
          email: string;
          id: string;
        };
        Insert: {
          created_at?: string;
          display_name?: string;
          email?: string;
          id: string;
        };
        Update: {
          created_at?: string;
          display_name?: string;
          email?: string;
          id?: string;
        };
        Relationships: [];
      };
      stock_balances: {
        Row: {
          location_id: string;
          product_id: string;
          quantity: number;
          workspace_id: string;
        };
        Insert: {
          location_id: string;
          product_id: string;
          quantity?: number;
          workspace_id: string;
        };
        Update: {
          location_id?: string;
          product_id?: string;
          quantity?: number;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "stock_balances_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stock_balances_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stock_balances_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      stock_ledger: {
        Row: {
          balance_after: number;
          created_at: string;
          created_by: string;
          delta: number;
          id: string;
          location_id: string;
          operation_id: string | null;
          product_id: string;
          workspace_id: string;
        };
        Insert: {
          balance_after: number;
          created_at?: string;
          created_by: string;
          delta: number;
          id?: string;
          location_id: string;
          operation_id?: string | null;
          product_id: string;
          workspace_id: string;
        };
        Update: {
          balance_after?: number;
          created_at?: string;
          created_by?: string;
          delta?: number;
          id?: string;
          location_id?: string;
          operation_id?: string | null;
          product_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "stock_ledger_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stock_ledger_operation_id_fkey";
            columns: ["operation_id"];
            isOneToOne: false;
            referencedRelation: "operations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stock_ledger_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stock_ledger_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      warehouses: {
        Row: {
          code: string;
          created_at: string;
          id: string;
          name: string;
          workspace_id: string;
        };
        Insert: {
          code: string;
          created_at?: string;
          id?: string;
          name: string;
          workspace_id: string;
        };
        Update: {
          code?: string;
          created_at?: string;
          id?: string;
          name?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "warehouses_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_members: {
        Row: {
          role: string;
          user_id: string;
          workspace_id: string;
        };
        Insert: {
          role: string;
          user_id: string;
          workspace_id: string;
        };
        Update: {
          role?: string;
          user_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspaces: {
        Row: {
          created_at: string;
          id: string;
          join_code: string;
          name: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          join_code?: string;
          name: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          join_code?: string;
          name?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      advance_operation: {
        Args: { next_status: string; op_id: string };
        Returns: undefined;
      };
      apply_stock: {
        Args: { amount: number; loc: string; op: string; p: string; w: string };
        Returns: undefined;
      };
      can_edit_operation: { Args: { op: string; w: string }; Returns: boolean };
      create_workspace: { Args: { workspace_name: string }; Returns: string };
      discard_draft_operation: { Args: { op_id: string }; Returns: undefined };
      is_manager: { Args: { w: string }; Returns: boolean };
      is_member: { Args: { w: string }; Returns: boolean };
      join_workspace: { Args: { code: string }; Returns: string };
      remove_member: {
        Args: { target_user: string; workspace: string };
        Returns: undefined;
      };
      set_member_role: {
        Args: { new_role: string; target_user: string; workspace: string };
        Returns: undefined;
      };
      shares_workspace: { Args: { other: string }; Returns: boolean };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
